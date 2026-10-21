<p align="center">
  <img src="frontend/public/sparta-shield.svg" alt="S.P.A.R.T.A. shield" width="84" />
</p>

# S.P.A.R.T.A.

**Smart Platform for Adversarial Readiness & Technical Assessment**

S.P.A.R.T.A. compares a resume with a job description and available GitHub repository evidence. It produces a review, runs a voice interview, and suggests resume improvements.

Repository evidence helps the interviewer ask specific technical questions. It does not prove who wrote the code or that every resume claim is true.

## What the application does

- **Resume review:** Extract PDF text, identify claims, compare skills with the job description, and calculate a readiness score.
- **GitHub ingestion:** Read supported repository files through GitHub's API, then include that evidence in the review and interview.
- **Voice interview:** Ask one question per turn, transcribe spoken answers, and follow the interview's topic progression.
- **Interview feedback:** Compare the spoken answers with the resume, job description, and available code evidence.
- **Resume reconstruction:** Generate editable replacements for existing bullets. Save selected replacements into a PDF copy without adding a summary page.
- **Themes:** Minimal brutalist styling, silver-and-cyan light mode, deep-blue dark mode, animated headlines, and retro button feedback.

Dashboard reconstruction and interview feedback are separate operations. Interview suggestions do not automatically change the uploaded PDF.

### Resume PDF support

`/analyze` reads every page, in order, for PDFs of up to **20 pages**, **10 MB**, and **60,000 extracted characters**. These limits support ordinary resumes and longer CVs while bounding OCR work and model input.

Native text pages use PyMuPDF. Pages that need OCR use NVIDIA Nemotron individually. Mixed digital/scanned documents are supported, and empty pages are skipped. Digital PDFs do not require an NVIDIA key.

Oversized, unreadable, and password-protected documents return clear errors. An OCR failure identifies the affected page. The endpoint never returns a successful partial extraction after a page fails or a limit is exceeded.

The resume review and interview both receive the accepted document's complete extracted text, up to the same 60,000-character limit. OCR quality still depends on scan clarity.

## Main flow

```text
Resume PDF + job description
  → /analyze: extract text and find a repository URL
  → GitHub API: default branch → file tree → selected text blobs
  → Groq: compare resume claims, repository evidence, and job requirements
  → Dashboard: review results and choose the next action
      ├─ Resume reconstruction → edit/select replacements → download PDF copy
      └─ Interview → spoken answers → interview feedback
```

### How GitHub evidence reaches the interview

1. `backend/main.py` accepts a repository URL or finds the first repository URL in the extracted resume text. Profile-only links are skipped.
2. `backend/ingest_github.py` detects the default branch unless the URL specifies a `/tree/...` branch. It downloads a bounded sample of text files.
3. `/analyze` includes `resume_text`, `code`, `repo_url`, `job_description`, `has_github`, and interview metadata in its JSON result.
4. The frontend saves that analysis in browser `sessionStorage` when the user opens the interview.
5. The interview sends the analysis as the `context` field through `/api/interrogation` to backend `/chat`.
6. `/chat` builds the model prompt from that request's snapshot. It does not use another upload's shared `current_user` record.

This handoff works after an unrelated upload or a backend worker restart. Missing or outdated context produces a request to analyze the resume again.

`has_github` is true only after a successful fetch supplies usable evidence. A failed fetch produces `github_error`, leaves `code` empty, and uses resume-only interview mode. Failed fetches are not cached.

### GitHub coverage and limits

- Public repositories can be read without a token. A backend `GITHUB_TOKEN` provides authenticated access, subject to its permissions and API limits.
- GitHub is the only supported code host today. The app does not search all repositories belonging to a profile.
- A `/tree/...` URL treats the whole suffix as the branch name. Repository subfolder links are not resolved separately.
- Supported text types include Python, JavaScript, TypeScript, Java, C/C++, C#, Go, Rust, SQL, Markdown, JSON, and notebooks.
- The scraper skips configured dependency, build, asset, and test directories. It skips individual files larger than 150,000 bytes.
- Each fetch includes at most 80 files and 50,000 characters. The last included file can be cut short. This is a sample, not a complete repository audit.
- Requests have a 20-second timeout. An incomplete GitHub file tree, unreadable-only repository, or failed blob request produces an explicit error.
- Successful repository samples use an in-memory cache with a one-hour lifetime and a 50-entry limit. Branch changes can remain cached until expiry.
- Interview prompts include at most 60,000 resume characters, 12,000 job-description characters, and 50,000 code characters.
- Resume URLs must appear in extracted text. Links present only in PDF annotations are not separately collected.

GitHub documents the recursive tree limits and public-access rules in its [Git trees API reference](https://docs.github.com/en/rest/git/trees).

## Technology and models

| Part | Technology | Role |
| --- | --- | --- |
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 | Upload, review, interview, and PDF download screens. |
| Backend | FastAPI, Python | Analysis, interview, reconstruction, and PDF endpoints. |
| Analysis and generation | Groq `openai/gpt-oss-120b` | Resume review, interview questions, and resume suggestions. |
| Validation and follow-up classification | Groq `openai/gpt-oss-20b` | Resume validation, project extraction, and answer classification. |
| PDF text | PyMuPDF | Native text extraction and targeted PDF replacements. |
| Scanned-page fallback | NVIDIA Nemotron OCR | Extract text from a rendered PDF page when native text is insufficient. |
| Speech input | Deepgram Nova-2 | Stream microphone audio and return transcripts. |
| Speech output | Deepgram Aura Athena | Read interview questions aloud. |

The follow-up classifier currently returns `FOLLOW_UP_REQUIRED`, `SUFFICIENT`, or `SURRENDER`. Python selects the next interview topic from those results and the question history. JEV is a future milestone; the current classifier is unchanged.

The readiness score uses section scores when available:

```text
round(0.40 × experience + 0.30 × skills + 0.15 × formatting + 0.15 × ATS compatibility)
```

The score is AI-assisted feedback, not a hiring decision or an independent verification result.

## Local setup

Use Python 3.11, Node.js 20.9 or newer, pnpm, and uv. The Render Blueprint specifies Python 3.11.8.

### Backend

From the repository root:

```bash
cd backend
uv venv venv --python 3.11
source venv/bin/activate
uv pip install -r requirements.txt
```

On Windows, activate the environment with `venv\Scripts\activate`.

Create `backend/.env` with your own values:

```dotenv
GROQ_API_KEY=your_groq_key
NVIDIA_API_KEY=your_nvidia_key
DEEPGRAM_API_KEY=your_deepgram_key
# Optional: authenticated GitHub access
GITHUB_TOKEN=your_github_token
```

Keep credentials out of source control. Revoke any token exposed in a chat, log, or public file.

```bash
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Backend: `http://127.0.0.1:8000`. API documentation: `http://127.0.0.1:8000/docs`.

### Frontend

In a second terminal, from the repository root:

```bash
cd frontend
pnpm install
```

Create `frontend/.env.local`:

```dotenv
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000
DEEPGRAM_API_KEY=your_deepgram_key
```

```bash
pnpm dev
```

Open `http://localhost:3000`. Upload a resume and job description before opening `/interrogation`.

Microphone access needs browser permission. The recorder chooses a supported format, including MP4 when WebM is unavailable. It waits for the final transcript before submitting an answer.

The current `/api/deepgram` implementation returns the configured key to the browser for speech requests. It does not mint a temporary token. Restrict that key's permissions; replacing this mechanism is a future milestone.

## Deployment

`render.yaml` defines separate backend and frontend web services.

| Setting | Backend | Frontend |
| --- | --- | --- |
| Root directory | `backend` | `frontend` |
| Build command | `pip install -r requirements.txt` | `pnpm install && pnpm build` |
| Start command | `uvicorn main:app --host 0.0.0.0 --port $PORT` | `pnpm start` |

Set service credentials in the hosting provider's environment settings. The frontend requires `DEEPGRAM_API_KEY` and `NEXT_PUBLIC_BACKEND_URL`.

The current default backend URL is `https://sparta-1l4n.onrender.com`. Set `NEXT_PUBLIC_BACKEND_URL` to override it. Rebuild the frontend after changing a public environment variable.

## Automated checks

The deterministic tests below use generated fixtures and mocked service responses. They do not need real API keys, a running server, or paid model calls.

From `backend/`, with its environment activated:

```bash
python -m unittest -v test_pdf_extraction test_github_context test_reconstruction test_resume_pdf
```

`test_github_context.py` checks public access, authenticated requests, branch selection, file filters, HTTP failures, timeouts, cache behavior, and missing evidence. It follows an analysis result into the real interview prompt and checks that another upload cannot replace its evidence.

`test_pdf_extraction.py` uses generated PDFs to check all 20 pages, mixed digital/scanned content, short and empty pages, limits, OCR failures, and invalid documents. It verifies that a later-page GitHub URL and text beyond the old prompt limits reach analysis and interview context.

The other two suites check reconstruction responses and targeted PDF replacements, including page preservation and rejection of ambiguous matches.

From `frontend/`:

```bash
node --test tests/*.test.cjs
pnpm exec tsc --noEmit
```

`interview-context.test.cjs` exercises the actual Next.js proxy with a mocked backend. It checks complete context forwarding, the backend URL, and actionable error responses. `speech-recorder.test.cjs` checks format fallback, transcript finalization, failures, and resource cleanup.

Older scripts such as `backend/test_api.py`, `backend/test_eval.py`, and `backend/test_glm.py` are manual service probes. They can need local files, running services, or live credentials. They are separate from the offline test command.

Mocked tests establish the application contract. They do not measure model quality, prove private-repository permissions, or verify a user's physical microphone.

## Repository map

```text
backend/
  main.py                    FastAPI routes and analysis/interview handoff
  brain.py                   Groq prompts, scoring, and interview progression
  ingest_github.py            GitHub tree and blob ingestion
  pipeline.py                 Native PDF extraction and NVIDIA OCR fallback
  resume_limits.py           Shared page, file-size, and text budgets
  resume_pdf.py               Targeted bullet replacement in PDF copies
  ingest_pdf.py               Separate pypdf parser
  test_github_context.py     GitHub and interview-context regression tests
  test_reconstruction.py     Reconstruction response tests
  test_resume_pdf.py         PDF replacement tests
  test_pdf_extraction.py     Multi-page extraction and analysis tests
frontend/
  app/page.tsx               Upload, dashboard, and reconstruction screens
  app/interrogation/page.tsx Voice interview and feedback
  app/api/                   Backend proxies and speech credential route
  app/components/            Logo, theme switch, and animated text
  app/hooks/                 Shared microphone hook
  app/lib/                   Microphone recording lifecycle
  tests/                     Recorder and interview proxy tests
  public/                    Website assets
render.yaml                  Render service configuration
```

## Current boundaries

- Resume PDF support is bounded to 20 pages, 10 MB, and 60,000 extracted characters. Larger documents are rejected rather than partly analyzed.
- Interview evidence lives in the browser's analysis snapshot. Source text therefore reaches the browser and session storage.
- Some legacy endpoints, including `/add_repo`, `/interview_start`, and `/generate_resume`, still use shared process memory. The main `/chat` handoff does not.
- Repository contents and model responses can be incomplete or incorrect. Review suggestions before using them.
- PDF replacements need a unique original match and enough space. They can be rejected when a replacement cannot fit. Exact source-font matching is not guaranteed.

## Future scope and milestones

These items are planned, not implemented:

- [ ] **More code hosts:** Add GitLab, Codeberg, and other Git hosting providers, including Forgejo/Gitea and self-hosted services. Use a shared provider interface for URL parsing, permissions, branches, file trees, and evidence errors.
- [ ] **JEV follow-up evaluation:** Define JEV's provider/model or evaluation contract, then compare it with the current light-model classifier before replacing it. Add classification and interview-progression regression tests.
- [ ] **Broader repository evidence:** Support multiple project URLs, explicit repository selection, full-tree pagination, commit history, and evidence citations.
- [ ] **PDF improvements:** Collect embedded repository links, improve font preservation, and preview replacements before download. Multi-page extraction is implemented within the documented limits.
- [ ] **Session storage:** Replace remaining shared legacy state with isolated, persistent analysis/interview sessions and expiry controls.
- [ ] **Speech access:** Replace browser delivery of the configured Deepgram key with scoped temporary access or a server-mediated speech connection.
- [ ] **Evaluation and CI:** Add optional live integration checks, model-quality datasets, and automated checks in continuous integration.
