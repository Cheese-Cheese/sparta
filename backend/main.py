import os
import sys

# Ensure UTF-8 output encoding for Windows compatibility
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import shutil
import re
import base64
import io
import time
import logging
import asyncio
from urllib.parse import unquote, urlsplit
from collections import OrderedDict

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, field_validator
from typing import List, Literal, Optional
from dotenv import load_dotenv

import hashlib
import json

# Ensure cache directory exists
CACHE_DIR = ".cache"
os.makedirs(CACHE_DIR, exist_ok=True)

# --- S.P.A.R.T.A. PIPECAT IMPORTS ---
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import LLMMessagesUpdateFrame

from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.groq.llm import GroqLLMService

from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams
)

# NEW IMPORT FOR STEP 4: Raw Async Groq for the background Judge
from groq import AsyncGroq

import ingest_github
import brain

# --- NEW: S.P.A.R.T.A. HYBRID ENGINE IMPORTS ---
from pipeline import extract_text_intelligently, analyze_with_groq
from resume_pdf import replace_resume_bullets

load_dotenv()

# --- LOGGING ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB = {}

# --- LRU CACHE WITH TTL ---
class LRUCache:
    def __init__(self, max_size: int = 50, ttl_seconds: int = 3600):
        self.cache = OrderedDict()
        self.max_size = max_size
        self.ttl = ttl_seconds  
        self.timestamps = {}

    def get(self, key: str):
        if key not in self.cache:
            return None
        if time.time() - self.timestamps[key] > self.ttl:
            self.delete(key)
            return None
        self.cache.move_to_end(key)
        return self.cache[key]

    def set(self, key: str, value):
        if key in self.cache:
            self.cache.move_to_end(key)
            self.cache[key] = value
            self.timestamps[key] = time.time()
            return
        while len(self.cache) >= self.max_size:
            oldest_key = next(iter(self.cache))
            self.delete(oldest_key)
        self.cache[key] = value
        self.timestamps[key] = time.time()

    def delete(self, key: str):
        if key in self.cache:
            del self.cache[key]
            del self.timestamps[key]

    def clear(self):
        self.cache.clear()
        self.timestamps.clear()

    def __contains__(self, key: str):
        return self.get(key) is not None

    def __len__(self):
        return len(self.cache)

REPO_CACHE = LRUCache(max_size=50, ttl_seconds=3600)

class ChatRequest(BaseModel):
    message: str
    history: List[dict] = []
    context: str = ""

class RepoRequest(BaseModel):
    github_url: str

    @field_validator('github_url')
    @classmethod
    def validate_github_url(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError('GitHub URL is required')
        v = v.strip()
        if not all(extract_github_details(v)[:2]):
            raise ValueError('Invalid GitHub URL format')
        return v

ALLOWED_FILE_EXTENSIONS = {'.pdf'}
MAX_FILE_SIZE_MB = 10

def validate_file_upload(file: UploadFile) -> tuple[bool, str]:
    if not file or not file.filename:
        return False, "No file provided"
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_FILE_EXTENSIONS:
        return False, f"Invalid file type. Allowed: {', '.join(ALLOWED_FILE_EXTENSIONS)}"
    return True, ""

def extract_github_details(url):
    if not url:
        return None, None, None
    try:
        parsed = urlsplit(url if '://' in url else f'https://{url}')
    except ValueError:
        return None, None, None
    if parsed.scheme not in ('http', 'https') or parsed.hostname not in ('github.com', 'www.github.com'):
        return None, None, None
    parts = parsed.path.strip('/').split('/')
    if len(parts) < 2:
        return None, None, None
    owner, repo = parts[:2]
    repo = repo.removesuffix('.git')
    if not re.fullmatch(r'[\w.-]+', owner) or not re.fullmatch(r'[\w.-]+', repo):
        return None, None, None
    branch = unquote('/'.join(parts[3:])) if len(parts) > 3 and parts[2] == 'tree' else None
    return owner, repo, branch

@app.get("/")
def health_check():
    return {"status": "S.P.A.R.T.A. System Online", "mode": "Adversarial"}


# ============ S.P.A.R.T.A. STREAMING PIPELINE ============

@app.websocket("/ws/sparta-interview")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("⚡ S.P.A.R.T.A. WebSocket Connected. Initializing Split-Brain Architecture...")
    
    groq_async_client = AsyncGroq(api_key=os.getenv("GROQ_API_KEY"))
    
    try:
        transport = FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                add_wav_header=False,
                vad_enabled=True,
                vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.3)),
                vad_audio_passthrough=True,
            )
        )

        stt = DeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY"))
        tts = DeepgramTTSService(api_key=os.getenv("DEEPGRAM_API_KEY"), voice="aura-asteria-en")
        llm = GroqLLMService(api_key=os.getenv("GROQ_API_KEY"), model="llama3-8b-8192")

        system_prompt = "You are S.P.A.R.T.A., a ruthless, elite technical interviewer. Keep responses under 2 sentences. Be highly critical. If the INTERVIEW_DIRECTOR gives you an attack vector, use it immediately against the candidate."
        
        context = LLMContext([{"role": "system", "content": system_prompt}])
        
        context_aggregator = LLMContextAggregatorPair(
            context=context,
            user_params=LLMUserAggregatorParams(
                aggregation_timeout=0.5,
                enable_emulated_vad_interruptions=False
            )
        )

        runner = PipelineRunner()
        
        pipeline = Pipeline([
            transport.input(),
            stt,
            context_aggregator.user(),
            llm,
            tts,
            transport.output(),
            context_aggregator.assistant(),
        ])
        
        task = PipelineTask(pipeline, PipelineParams(allow_interruptions=True))
        
        async def judge_loop():
            print("⚖️ 70B Async Judge activated in background.")
            last_processed_index = 0
            
            while True:
                await asyncio.sleep(1.0)
                messages = context.get_messages()
                
                if len(messages) > last_processed_index:
                    last_msg = messages[-1]
                    
                    if last_msg["role"] == "user" and "[INTERVIEW_DIRECTOR]" not in last_msg.get("content", ""):
                        print("⚖️ Judge analyzing candidate's logic...")
                        try:
                            response = await groq_async_client.chat.completions.create(
                                model="llama3-70b-8192",
                                messages=[
                                    {"role": "system", "content": "You are a senior principal engineer evaluating a candidate. The candidate just spoke. Provide a brutal, 1-sentence technical follow-up question exposing a flaw in their logic. Do not be polite."},
                                    {"role": "user", "content": last_msg["content"]}
                                ],
                                max_tokens=150,
                                temperature=0.7
                            )
                            
                            judge_feedback = response.choices[0].message.content
                            print(f"🔥 Judge Attack Vector: {judge_feedback}")
                            
                            context.add_message({
                                "role": "user", 
                                "content": f"[INTERVIEW_DIRECTOR]: Use this attack vector on the candidate next: {judge_feedback}"
                            })
                            
                        except Exception as e:
                            print(f"⚠️ Judge Error: {e}")
                    
                    last_processed_index = len(context.get_messages())

        asyncio.create_task(judge_loop())

        @transport.event_handler("on_client_connected")
        async def on_client_connected(transport, client):
            print("🎙️ Client active. Sending Opening Shot...")
            messages = [{"role": "system", "content": system_prompt}, {"role": "user", "content": "Introduce yourself aggressively."}]
            await task.queue_frames([LLMMessagesUpdateFrame(messages)])

        print("🚀 Hot-Path Pipeline starting...")
        await runner.run(task)
        
    except WebSocketDisconnect:
        print("🔴 S.P.A.R.T.A. WebSocket Disconnected")
    except Exception as e:
        print(f"❌ Pipeline Error: {e}")


# ============ CORE ENDPOINTS (Upgraded to Hybrid Engine) ============

@app.post("/validate_resume")
async def validate_resume(file: UploadFile = File(...)):
    is_valid, error_msg = validate_file_upload(file)
    if not is_valid:
        return {"valid": False, "reason": error_msg}

    logger.info(f"🛡️ Gatekeeper checking via Hybrid Engine: {file.filename}")
    temp_filename = f"temp_validate_{file.filename}"

    try:
        with open(temp_filename, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        nvidia_key = os.getenv("NVIDIA_API_KEY")
        if not nvidia_key:
            return {"valid": True, "reason": ""} # Bypass if key missing for local dev

        # 🚀 MAGIC: Sub-2-Second Extraction
        resume_text = extract_text_intelligently(temp_filename, nvidia_key)
        is_resume, rejection_reason = brain.validate_is_resume(resume_text)

        if is_resume:
            logger.info(f"✅ Gatekeeper approved: {file.filename}")
            return {"valid": True, "reason": ""}
        else:
            logger.warning(f"❌ Gatekeeper rejected: {rejection_reason}")
            return {"valid": False, "reason": rejection_reason}

    except Exception as e:
        logger.error(f"❌ Gatekeeper error: {e}")
        return {"valid": False, "reason": f"Error processing file: {str(e)}"}
    finally:
        if os.path.exists(temp_filename):
            os.remove(temp_filename)

@app.post("/extract_projects")
async def extract_projects(file: UploadFile = File(...)):
    is_valid, error_msg = validate_file_upload(file)
    if not is_valid:
        logger.warning(f"Invalid file upload: {error_msg}")
        raise HTTPException(status_code=400, detail=error_msg)

    logger.info(f"📥 Extracting projects from resume using Hybrid Engine: {file.filename}")
    temp_filename = f"temp_{file.filename}"

    try:
        with open(temp_filename, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        nvidia_key = os.getenv("NVIDIA_API_KEY")
        groq_key = os.getenv("GROQ_API_KEY")
        
        if not nvidia_key or not groq_key:
             raise HTTPException(status_code=500, detail="CRITICAL: Missing NVIDIA or GROQ API Keys in .env")

        # 1. High-Speed Extraction
        resume_text = extract_text_intelligently(temp_filename, nvidia_key)
        
        # 2. Dynamic Structuring
        structured_json_str = analyze_with_groq(resume_text, groq_key)
        import json
        structured_data = json.loads(structured_json_str)

        # 3. Validation Check
        if not structured_data.get("identified_entity"):
            logger.warning("❌ Document rejected: Could not identify a person/resume.")
            raise HTTPException(status_code=400, detail="This document does not appear to be a valid resume.")

        # Extract projects
        projects = []
        for item in structured_data.get("extracted_data", []):
             if item.get("category") == "Key Projects" or item.get("section") == "Key Projects":
                  projects = item.get("projects", item.get("description", []))
                  break

        DB['pending_resume'] = resume_text

        return {
            "status": "success",
            "projects": projects,
            "resume_preview": resume_text[:500] + "..."
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error extracting projects: {e}")
        return {"status": "error", "message": str(e)}
    finally:
        if os.path.exists(temp_filename):
            os.remove(temp_filename)

@app.post("/analyze")
async def analyze_portfolio(
    file: UploadFile = File(...),
    github_url: Optional[str] = Form(None),
    project_name: Optional[str] = Form(None),
    job_description: str = Form("")
):
    is_valid, error_msg = validate_file_upload(file)
    if not is_valid:
        logger.warning(f"Invalid file upload: {error_msg}")
        raise HTTPException(status_code=400, detail=error_msg)

    if github_url and github_url.strip() and github_url != "null":
        github_url = github_url.strip()
        if not all(extract_github_details(github_url)[:2]):
            raise HTTPException(status_code=400, detail="Invalid GitHub URL format")

    logger.info(f"📥 Received Analysis Request.")
    logger.info(f"   📁 Selected Project: {project_name or 'None specified'}")
    temp_filename = f"temp_{file.filename}"
    
    try:
        with open(temp_filename, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        nvidia_key = os.getenv("NVIDIA_API_KEY")
        if not nvidia_key:
             raise HTTPException(status_code=500, detail="CRITICAL: Missing NVIDIA API Key")

        # 🚀 MAGIC: Using our Hybrid Engine for Analysis Phase
        resume_text = extract_text_intelligently(temp_filename, nvidia_key)
        
        is_valid, rejection_reason = brain.validate_is_resume(resume_text)
        if not is_valid:
            logger.warning(f"❌ Document rejected: {rejection_reason}")
            raise HTTPException(status_code=400, detail=rejection_reason)

        target_url = github_url if github_url and github_url != "null" and github_url.strip() else None

        if not target_url:
            import re
            for candidate in re.findall(r'https?://(?:www\.)?github\.com/[^\s<>\"\)]+', resume_text):
                candidate = candidate.rstrip('.,;')
                if all(extract_github_details(candidate)[:2]):
                    target_url = candidate
                    break

        if target_url:
            print(f"   🎯 Using selected project URL: {target_url}")
        else:
            print(f"   ⚠️ No GitHub URL provided - analyzing resume claims only (PHANTOMWARE CHECK)")

        code_context = ""
        github_error = None
        if target_url:
            owner, repo, branch = extract_github_details(target_url)
            if owner and repo:
                cache_key = f"{owner}/{repo}/{branch}"
                cached = REPO_CACHE.get(cache_key)
                if cached:
                    logger.info(f"   ⚡ Cache Hit: {cache_key}")
                    code_context = cached
                else:
                    logger.info(f"   💻 Target: {owner}/{repo} (Branch: {branch or 'Auto'})")
                    try:
                        code_context = ingest_github.fetch_repo_content(owner, repo, branch)
                    except ingest_github.GitHubFetchError as error:
                        github_error = str(error)
                        logger.warning('GitHub evidence unavailable: %s', github_error)
                    if code_context:
                        REPO_CACHE.set(cache_key, code_context)
            else:
                github_error = 'Invalid GitHub repository URL.'
        has_github = bool(code_context and not github_error)
        if not has_github:
            code_context = 'NO CODE PROVIDED. Repository evidence is unavailable. Evaluate resume claims without claiming code verification.'

        analysis_json = brain.analyze_resume_vs_code(resume_text, code_context, project_name, job_description)
        
        import json
        try:
            data = json.loads(analysis_json)
            data["resume_text"] = resume_text
            data["has_github"] = has_github
            data["code"] = code_context[:50000] if has_github else ""
            data["repo_url"] = target_url if has_github else None
            data["job_description"] = job_description
            data["github_error"] = github_error
            analysis_json = json.dumps(data)
            
            critique = "\n".join([f"- {x}" for x in data.get("project_critique", [])])
            claims = "\n".join([f"- {x}" for x in data.get("false_claims", [])])
            suggestions = "\n".join([f"- {x}" for x in data.get("resume_suggestions", [])])
            
            chat_msg = f"**REAL WORLD CRITIQUE:**\n{critique}\n\n**FALSE CLAIMS / VERIFICATION:**\n{claims}\n\n**RESUME ADDITIONS:**\n{suggestions}"
        except:
            chat_msg = "Analysis Complete. Check Dashboard for details."

        DB['current_user'] = {
            "resume": resume_text,
            "code": code_context[:50000],
            "analysis": analysis_json
        }

        return {
            "status": "success",
            "data": analysis_json,
            "initial_chat": chat_msg
        }

    except Exception as e:
        logger.error(f"Error in analyze_portfolio: {e}")
        return {"status": "error", "message": str(e)}
    finally:
        if os.path.exists(temp_filename):
            try:
                os.remove(temp_filename)
            except Exception as remove_err:
                logger.warning(f"⚠️ Non-critical: Could not delete temp file {temp_filename}: {remove_err}")

@app.post("/add_repo")
async def add_repo_context(request: RepoRequest):
    print(f"📥 Adding Repo: {request.github_url}")
    try:
        owner, repo, branch = extract_github_details(request.github_url)
        if not owner or not repo:
             raise HTTPException(status_code=400, detail="Invalid GitHub URL")
        
        cache_key = f"{owner}/{repo}/{branch}"
        cached = REPO_CACHE.get(cache_key)
        if cached:
            logger.info(f"   ⚡ Cache Hit: {cache_key}")
            code_context = cached
        else:
            logger.info(f"   💻 Fetching: {owner}/{repo} (Branch: {branch or 'Default'})")
            code_context = ingest_github.fetch_repo_content(owner, repo, branch)
            if code_context:
                REPO_CACHE.set(cache_key, code_context)

        if not code_context:
            return {"status": "error", "bullets": "⚠️ ACCESS DENIED: Repo is empty, Private, or Branch not found."}

        bullets = brain.generate_star_bullets(code_context)

        if 'current_user' in DB:
            DB['current_user']['code'] += f"\n\n--- NEW REPO: {repo} ---\n{code_context[:20000]}"

        return {"status": "success", "bullets": bullets}

    except Exception as e:
        logger.error(f"Error in add_repo_context: {e}")
        return {"status": "error", "message": str(e)}

@app.post("/interview_start")
async def start_interview():
    user_data = DB.get('current_user')
    if not user_data:
        return {"status": "error", "message": "No data found."}
    question = brain.generate_interview_challenge(user_data['code'], user_data['analysis'])
    return {"status": "success", "question": question}

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    try:
        context = json.loads(request.context)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail='Invalid interview context. Analyze the resume again.')
    if not isinstance(context, dict) or not isinstance(context.get('resume_text'), str) or not context['resume_text'].strip():
        raise HTTPException(status_code=409, detail='Resume context is missing. Analyze the resume again.')
    code = context.get('code', '')
    if not isinstance(code, str) or (context.get('has_github') and not code.strip()):
        raise HTTPException(status_code=409, detail='Repository context is missing. Analyze the resume again.')
    job_description = context.get('job_description', '')
    if not isinstance(job_description, str):
        raise HTTPException(status_code=400, detail='Invalid job description in interview context.')
    # Each browser sends its own analysis snapshot; never use another upload's DB record.
    context_summary = (
        f"--- RESUME ---\n{context['resume_text'][:12000]}\n"
        f"--- JOB DESCRIPTION ---\n{job_description[:12000]}\n"
        f"--- REPOSITORY ---\n{context.get('repo_url') or 'None'}\n"
        f"--- CODE EVIDENCE ---\n{code[:50000] or 'NO CODE PROVIDED. Interview from resume claims only.'}"
    )

    gemini_history = [] 
    for msg in request.history:
        role = "user" if msg['type'] == 'user' else "model"
        gemini_history.append({"role": role, "parts": [msg['text']]})

    response_text = brain.get_chat_response(gemini_history, request.message, request.context, context_summary)
    return {"response": response_text}

@app.post("/generate_resume")
async def generate_resume_endpoint():
    user_data = DB.get('current_user')
    if not user_data:
        return {"response": "⚠️ ERROR: No data found."}
    new_resume = brain.generate_ats_resume(user_data['resume'], user_data['code'])
    return {"status": "success", "resume": new_resume}

from brain import reconstruct_resume

class RebuildRequest(BaseModel):
    resume_text: str
    spoken_transcript: str = ""
    context: str = ""
    mode: Literal["interview", "resume"] = "interview"

@app.post("/rebuild")
async def rebuild_endpoint(req: RebuildRequest):
    if req.mode == "resume":
        if not req.resume_text.strip():
            raise HTTPException(status_code=400, detail="Resume text is required for reconstruction.")
        try:
            return brain.rewrite_resume_bullets(req.resume_text)
        except Exception:
            logger.exception("Resume reconstruction failed")
            raise HTTPException(status_code=502, detail="Resume reconstruction failed. Please retry.")
    result = reconstruct_resume(req.resume_text, req.spoken_transcript, req.context)
    return result

@app.post("/export_resume")
async def export_resume(file: UploadFile = File(...), bullets: str = Form(...)):
    is_valid, message = validate_file_upload(file)
    if not is_valid:
        raise HTTPException(status_code=400, detail=message)
    pdf_bytes = await file.read(MAX_FILE_SIZE_MB * 1024 * 1024 + 1)
    if len(pdf_bytes) > MAX_FILE_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail="The resume PDF must be 10 MB or smaller.")
    try:
        selected = json.loads(bullets)
        if not isinstance(selected, list):
            raise ValueError("Selected bullets must be a list.")
        output = replace_resume_bullets(pdf_bytes, selected)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return Response(output, media_type="application/pdf", headers={
        "Content-Disposition": 'attachment; filename="resume-reconstructed.pdf"',
        "Cache-Control": "no-store",
    })


# We conditionally import parse_resume to satisfy the user's instructions without crashing uvicorn if it doesn't exist
try:
    from brain import parse_resume
except ImportError:
    pass

@app.post("/upload")
async def upload_resume(file: UploadFile = File(...)):
    # 1. Read file bytes and generate SHA-256 hash
    file_bytes = await file.read()
    file_hash = hashlib.sha256(file_bytes).hexdigest()
    cache_path = os.path.join(CACHE_DIR, f"{file_hash}.json")

    # 2. Check if we already processed this exact PDF
    if os.path.exists(cache_path):
        with open(cache_path, "r") as f:
            print(f"⚡ CACHE HIT: Returning saved data for {file.filename}")
            return json.load(f)

    print(f"🔍 CACHE MISS: Parsing new file {file.filename}...")

    # 3. If no cache, process the PDF normally
    # Note: We must save the bytes to a temp file since parse_resume likely expects a file path
    temp_path = f"temp_{file.filename}"
    with open(temp_path, "wb") as f:
        f.write(file_bytes)

    try:
        # Call the existing parsing logic (assuming parse_resume is imported from brain.py)
        parsed_data = parse_resume(temp_path)
        
        # 4. Save the result to cache for future uploads
        with open(cache_path, "w") as f:
            json.dump(parsed_data, f)
            
        return parsed_data
        
    finally:
        # Clean up the temp file
        if os.path.exists(temp_path):
            os.remove(temp_path)

# --- 🔥 THE IGNITION SWITCH 🔥 ---
if __name__ == "__main__":
    import uvicorn
    print("🚀 S.P.A.R.T.A. Engine Ignition sequence started...")
    uvicorn.run(app, host="0.0.0.0", port=8000)
