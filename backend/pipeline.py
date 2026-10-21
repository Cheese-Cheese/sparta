import os
import time
import base64
import requests
import fitz  # PyMuPDF
from groq import Groq
from resume_limits import MAX_RESUME_PAGES, MAX_RESUME_CHARS, MAX_RESUME_BYTES

# --- HELPER: The Token Shredder (For OCR Fallback) ---
def strip_ocr_metadata(data) -> list:
    """Recursively hunts down text inside the NVIDIA JSON and drops heavy coordinates."""
    extracted = []
    if isinstance(data, dict):
        for k, v in data.items():
            if k.lower() in ['text', 'content', 'value'] and isinstance(v, str):
                extracted.append(v)
            else:
                extracted.extend(strip_ocr_metadata(v))
    elif isinstance(data, list):
        for item in data:
            extracted.extend(strip_ocr_metadata(item))
    return extracted

class ResumeExtractionError(ValueError):
    """A resume cannot be fully extracted within the supported limits."""

    def __init__(self, message: str, status_code: int = 422):
        super().__init__(message)
        self.status_code = status_code


def _extract_page_text(page, nvidia_key: str) -> str:
    native_text = page.get_text("text").strip()
    images = page.get_images()
    if len(native_text) > 50 or (native_text and not images):
        return native_text
    # Empty pages need no paid OCR call. Drawings can contain outlined text.
    if not images and not page.get_drawings():
        return native_text
    number = page.number + 1
    if not nvidia_key:
        raise ResumeExtractionError(
            f"Resume page {number} needs OCR. Configure NVIDIA_API_KEY and retry.", 503
        )

    # Keep ordinary pages at 3x resolution, but bound large-page raster memory.
    area = max(page.rect.width * page.rect.height, 1)
    zoom = min(3.0, (6000000 / area) ** 0.5)
    image = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom)).tobytes("png")
    encoded = base64.b64encode(image).decode("ascii")
    try:
        response = requests.post(
            "https://ai.api.nvidia.com/v1/infer/nvidia/nemotron-ocr-v1",
            headers={"Authorization": f"Bearer {nvidia_key}", "Accept": "application/json", "Content-Type": "application/json"},
            json={"input": [{"type": "image_url", "url": f"data:image/png;base64,{encoded}"}], "merge_levels": ["line"]},
            timeout=(10, 45),
        )
        if response.status_code != 200:
            raise ResumeExtractionError(
                f"Could not read resume page {number}: OCR service returned HTTP {response.status_code}. Retry the upload.", 502
            )
        text = "\n".join(strip_ocr_metadata(response.json())).strip()
    except ResumeExtractionError:
        raise
    except (requests.RequestException, ValueError) as error:
        raise ResumeExtractionError(
            f"Could not read resume page {number}: OCR service failed or timed out. Retry the upload.", 502
        ) from error
    if not text:
        raise ResumeExtractionError(f"Could not read resume page {number}: OCR returned no text. Upload a clearer PDF.")
    return text


def extract_text_intelligently(pdf_path: str, nvidia_key: str, page_number: int | None = None) -> str:
    """Extract all pages by default, or one explicitly selected zero-based page."""
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"Missing file: {pdf_path}")
    if os.path.getsize(pdf_path) > MAX_RESUME_BYTES:
        raise ResumeExtractionError("The resume PDF must be 10 MB or smaller.", 413)
    try:
        with fitz.open(pdf_path) as document:
            if not document.is_pdf:
                raise ResumeExtractionError("Upload a valid PDF resume.")
            if document.needs_pass:
                raise ResumeExtractionError("Remove the PDF password before uploading the resume.")
            if len(document) > MAX_RESUME_PAGES:
                raise ResumeExtractionError(f"Resume PDFs can contain at most {MAX_RESUME_PAGES} pages. Upload a shorter document.", 413)
            if page_number is not None and not 0 <= page_number < len(document):
                raise ResumeExtractionError("The selected PDF page does not exist.")
            pages = range(len(document)) if page_number is None else (page_number,)
            parts = []
            total = 0
            for index in pages:
                text = _extract_page_text(document.load_page(index), nvidia_key)
                if not text:
                    continue
                total += len(text) + (2 if parts else 0)
                if total > MAX_RESUME_CHARS:
                    raise ResumeExtractionError(
                        f"Resume text exceeds {MAX_RESUME_CHARS:,} characters. Upload a shorter document.", 413
                    )
                parts.append(text)
    except ResumeExtractionError:
        raise
    except (RuntimeError, ValueError) as error:
        raise ResumeExtractionError("Could not read the PDF. Upload a valid, uncorrupted resume PDF.") from error
    if not parts:
        raise ResumeExtractionError("The PDF has no readable resume text.")
    return "\n\n".join(parts)


# --- STAGE 3: THE BRAIN (Groq Dynamic JSON Structuring) ---
def analyze_with_groq(document_text: str, groq_key: str) -> str:
    print("🧠 Brain: Structuring document data via Groq (llama-3.1-8b-instant)...")
    client = Groq(api_key=groq_key)
    
    system_prompt = """
    You are a professional document intelligence engine. 
    Analyze the provided text and convert it into a strictly structured JSON object.
    
    Schema Requirements:
    - "identified_entity": (String: The name of the person or institution)
    - "document_type": (String: e.g., Resume, Timetable, Marks Card)
    - "primary_contact": (String: Email/Phone if available, else null)
    - "extracted_data": (Array of objects. Break down skills, projects, and experience logically.)
    
    Output ONLY valid JSON. No conversational filler or formatting blocks like ```json.
    """
    
    chat_completion = client.chat.completions.create(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": document_text}
        ],
        model="llama-3.1-8b-instant",
        temperature=0.0,
        response_format={"type": "json_object"}
    )
    return chat_completion.choices[0].message.content


# --- EXECUTION ENGINE ---
if __name__ == "__main__":
    NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "YOUR_NVIDIA_API_KEY")
    GROQ_API_KEY = os.getenv("GROQ_API_KEY", "YOUR_GROQ_API_KEY")

    LOCAL_PDF = "test.pdf"

    if "YOUR_" in NVIDIA_API_KEY or "YOUR_" in GROQ_API_KEY:
        print("❌ Error: API keys missing. Paste your real keys before running.")
    else:
        try:
            start_time = time.time()
            
            # 1. Hybrid Extraction (Digital Text OR High-Res PNG OCR)
            raw_text = extract_text_intelligently(LOCAL_PDF, NVIDIA_API_KEY)
            
            # 2. Brain Analysis
            structured_json = analyze_with_groq(raw_text, GROQ_API_KEY)
            
            end_time = time.time()
            
            print("\n✅ --- FINAL PIPELINE OUTPUT --- ✅\n")
            print(structured_json)
            print(f"\n⏱️  Telemetry: Total Pipeline Execution Time: {end_time - start_time:.2f} seconds")
            
        except Exception as e:
            print(f"\n❌ Pipeline failed: {e}")
