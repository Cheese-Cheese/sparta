import os
import requests
import base64
import binascii
from urllib.parse import quote
from dotenv import load_dotenv

load_dotenv()
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")

LOGIC_EXTENSIONS = {
    '.py', '.js', '.ts', '.tsx', '.jsx', '.java', '.cpp', '.c', 
    '.cs', '.go', '.rb', '.php', '.swift', '.kt', '.rs', '.sql', '.ipynb',
    '.json', '.md' # Added JSON/MD for context
}

IGNORED_DIRS = {
    'node_modules', 'venv', 'env', 'dist', 'build', 'target', 
    '__pycache__', '.git', '.idea', '.vscode', 'bin', 'obj', 
    'public', 'assets', 'images', 'test', 'tests'
}

REQUEST_TIMEOUT = 20
MAX_CONTEXT_CHARS = 50000
MAX_FILES = 80


class GitHubFetchError(ValueError):
    """GitHub did not provide usable repository evidence."""


class RepositoryEvidence(str):
    """Text-compatible repository sample with explicit coverage metadata."""
    def __new__(cls, text, coverage):
        sample = super().__new__(cls, text)
        sample.coverage = coverage
        return sample


def evidence_coverage(sample):
    """Old caller-owned snapshots may contain text without coverage information."""
    return getattr(sample, 'coverage', {'status': 'unknown' if sample else 'unavailable'})


def fetch_repo_content(owner: str, repo: str, branch: str = None):
    """Read a bounded sample of repository text through GitHub's REST API."""
    headers = {'Accept': 'application/vnd.github+json'}
    if GITHUB_TOKEN:
        headers['Authorization'] = f'Bearer {GITHUB_TOKEN}'
    base_url = f"https://api.github.com/repos/{quote(owner, safe='')}/{quote(repo, safe='')}"

    def get_json(url):
        try:
            response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as error:
            raise GitHubFetchError('GitHub could not be reached. Retry the analysis.') from error
        if response.status_code != 200:
            raise GitHubFetchError(f'GitHub returned HTTP {response.status_code}. Check repository access, the branch, and API limits.')
        try:
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError('Expected a JSON object')
            return payload
        except ValueError as error:
            raise GitHubFetchError('GitHub returned an unreadable response.') from error

    if not branch:
        branch = get_json(base_url).get('default_branch')
        if not branch:
            raise GitHubFetchError('GitHub did not return a default branch.')
    tree = get_json(f"{base_url}/git/trees/{quote(branch, safe='')}?recursive=1")
    if tree.get('truncated'):
        raise GitHubFetchError('GitHub returned an incomplete file tree. Select a smaller repository.')

    collected = []
    used_chars = 0
    coverage = {'status': 'partial', 'branch': branch, 'tree_sha': tree.get('sha'),
                'total_files': 0, 'included_files': [], 'truncated_files': [],
                'omitted': {'directory_filter': 0, 'unsupported_type': 0, 'oversized': 0,
                            'unreadable': 0, 'empty': 0, 'budget': 0}}
    for entry in sorted(tree.get('tree', []), key=lambda item: item.get('path', '')):
        path = entry.get('path', '')
        if entry.get('type') != 'blob':
            continue
        coverage['total_files'] += 1
        if not entry.get('sha'):
            coverage['omitted']['unreadable'] += 1
            continue
        if any(part in IGNORED_DIRS for part in path.split('/')):
            coverage['omitted']['directory_filter'] += 1
            continue
        if not any(path.lower().endswith(ext) for ext in LOGIC_EXTENSIONS):
            coverage['omitted']['unsupported_type'] += 1
            continue
        if entry.get('size', 0) > 150000:
            coverage['omitted']['oversized'] += 1
            continue
        header = f"\n\n--- FILE: {path} ---\n"
        if len(collected) >= MAX_FILES or MAX_CONTEXT_CHARS - used_chars <= len(header):
            coverage['omitted']['budget'] += 1
            continue
        content = get_json(f"{base_url}/git/blobs/{quote(entry['sha'], safe='')}")
        if content.get('encoding') != 'base64':
            coverage['omitted']['unreadable'] += 1
            continue
        try:
            encoded = ''.join(content.get('content', '').split())
            decoded = base64.b64decode(encoded, validate=True).decode('utf-8')
        except (ValueError, UnicodeDecodeError, binascii.Error):
            coverage['omitted']['unreadable'] += 1
            continue
        if not decoded.strip():
            coverage['omitted']['empty'] += 1
            continue
        section = header + decoded
        remaining = MAX_CONTEXT_CHARS - used_chars
        collected.append(section[:remaining])
        coverage['included_files'].append(path)
        if len(section) > remaining:
            coverage['truncated_files'].append(path)
        used_chars += len(collected[-1])
    if not collected:
        raise GitHubFetchError('Repository has no readable files within the supported paths and size limits.')
    coverage['included_count'] = len(collected)
    coverage['text_chars'] = used_chars
    if not sum(coverage['omitted'].values()) and not coverage['truncated_files']:
        coverage['status'] = 'complete'
    return RepositoryEvidence(''.join(collected), coverage)
