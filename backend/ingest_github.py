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
            return response.json()
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
    for entry in sorted(tree.get('tree', []), key=lambda item: item.get('path', '')):
        path = entry.get('path', '')
        if entry.get('type') != 'blob' or not entry.get('sha'):
            continue
        if any(part in IGNORED_DIRS for part in path.split('/')):
            continue
        if not any(path.lower().endswith(ext) for ext in LOGIC_EXTENSIONS):
            continue
        if entry.get('size', 0) > 150000:
            continue
        if len(collected) >= MAX_FILES or used_chars >= MAX_CONTEXT_CHARS:
            break
        content = get_json(f"{base_url}/git/blobs/{quote(entry['sha'], safe='')}")
        if content.get('encoding') != 'base64':
            continue
        try:
            encoded = ''.join(content.get('content', '').split())
            decoded = base64.b64decode(encoded, validate=True).decode('utf-8')
        except (ValueError, UnicodeDecodeError, binascii.Error):
            continue
        if not decoded.strip():
            continue
        section = f"\n\n--- FILE: {path} ---\n{decoded}"
        remaining = MAX_CONTEXT_CHARS - used_chars
        # Do not include a filename without any of its contents.
        if remaining <= len(section) - len(decoded):
            break
        collected.append(section[:remaining])
        used_chars += len(collected[-1])
    if not collected:
        raise GitHubFetchError('Repository has no readable files within the supported paths and size limits.')
    return ''.join(collected)
