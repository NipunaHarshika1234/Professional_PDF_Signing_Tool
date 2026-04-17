const { PDFDocument } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

let state = {
    pdfBytes: null,
    pdfDoc: null,
    currentPage: 1,
    numPages: 0,
    scale: 1.5,
    zoom: 1.0,
    activeSignatures: [], // Array of { id, dataUrl, x, y, w, h }
    savedSignatures: [], // Base64 data strings
    isDraggingViewport: false,
    viewportPos: { x: 0, y: 0 }
};

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();
    initSigPad();
    initViewportDraggable();
    initDropZone();

    document.getElementById('pdf-input').onchange = (e) => handleFile(e.target.files[0]);
});

// --- Tabs ---
function showTab(id) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    
    document.getElementById(id).classList.add('active');
    const navBtn = Array.from(document.querySelectorAll('.nav-item')).find(n => n.onclick.toString().includes(id));
    if (navBtn) navBtn.classList.add('active');

    // Re-initialize or resize signature pad if switching to create tab
    if (id === 'create-tab') {
        setTimeout(resizeSigCanvas, 100);
    }
}

// --- Signature Pad ---
let sigPad;
function initSigPad() {
    const canvas = document.getElementById('signature-canvas');
    if (!sigPad) {
        sigPad = new SignaturePad(canvas, {
            backgroundColor: 'rgba(255,255,255,0)',
            penColor: 'rgb(0,0,0)'
        });
    }
    resizeSigCanvas();
}

function resizeSigCanvas() {
    const canvas = document.getElementById('signature-canvas');
    if (!canvas) return;
    
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const wrapper = canvas.parentElement;
    
    if (wrapper.clientWidth === 0) return; // Still hidden

    canvas.width = wrapper.clientWidth * ratio;
    canvas.height = wrapper.clientHeight * ratio;
    canvas.getContext("2d").scale(ratio, ratio);
    
    if (sigPad) sigPad.clear(); // clear and reset for new size
}

function setPenColor(c) { sigPad.penColor = c; }
function setPenWidth(w) { 
    sigPad.minWidth = parseFloat(w); 
    sigPad.maxWidth = parseFloat(w) + 1; 
}
function clearSignature() { sigPad.clear(); }

function saveSignatureToBank() {
    if (sigPad.isEmpty()) return showToast("Please sign first");
    const dataUrl = sigPad.toDataURL();
    state.savedSignatures.push(dataUrl);
    updateBankUI();
    showToast("Added to your bank!");
    showTab('editor-tab');
    sigPad.clear();
}

function updateBankUI() {
    const list = document.getElementById('bank-list');
    list.innerHTML = '';
    state.savedSignatures.forEach((sig, idx) => {
        const div = document.createElement('div');
        div.className = 'signature-thumb';
        div.draggable = true;
        div.dataset.index = idx;
        div.innerHTML = `<img src="${sig}" />`;
        
        div.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', idx);
        });
        
        list.appendChild(div);
    });
}

// --- PDF Rendering ---
async function handleFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
        const buffer = e.target.result;
        state.pdfBytes = new Uint8Array(buffer);
        
        // Verify PDF Header (%PDF-)
        if (state.pdfBytes[0] !== 0x25 || state.pdfBytes[1] !== 0x50 || state.pdfBytes[2] !== 0x44 || state.pdfBytes[3] !== 0x46) {
            showToast("Error: This file is not a valid PDF document.");
            state.pdfBytes = null;
            return;
        }

        try {
            const loadingTask = pdfjsLib.getDocument({ data: state.pdfBytes.slice(0) });
            state.pdfDoc = await loadingTask.promise;
            state.numPages = state.pdfDoc.numPages;
            state.currentPage = 1;
            state.activeSignatures = []; 
            
            renderPage();
            
            document.getElementById('file-name').innerText = file.name;
            document.getElementById('file-info').classList.remove('hidden');
            document.getElementById('page-nav').classList.remove('hidden');
            document.getElementById('zoom-ctrl').classList.remove('hidden');
            document.getElementById('download-btn').classList.remove('hidden');
            
            showTab('editor-tab');
        } catch (err) {
            console.error("PDF Load Error:", err);
            showToast("Error loading PDF: " + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
}

async function renderPage() {
    const page = await state.pdfDoc.getPage(state.currentPage);
    const canvas = document.getElementById('pdf-canvas');
    const ctx = canvas.getContext('2d');
    
    const viewport = page.getViewport({ scale: state.scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: ctx, viewport }).promise;
    
    document.getElementById('page-num-display').innerText = `Page ${state.currentPage} / ${state.numPages}`;
    updateSigsOnDisplay();
    document.getElementById('editor-hint').style.display = 'none';
}

function prevPage() { if(state.currentPage > 1) { state.currentPage--; renderPage(); } }
function nextPage() { if(state.currentPage < state.numPages) { state.currentPage++; renderPage(); } }

function adjustZoom(delta) {
    state.zoom = Math.max(0.5, Math.min(3.0, state.zoom + delta));
    document.getElementById('pdf-container').style.transform = `scale(${state.zoom})`;
    document.getElementById('zoom-level').innerText = Math.round(state.zoom * 100) + '%';
}

// --- Panning logic ---
function initViewportDraggable() {
    const viewport = document.getElementById('pdf-viewport');
    let isDown = false;
    let startX, startY;
    let scrollLeft, scrollTop;

    viewport.addEventListener('mousedown', (e) => {
        if (e.target !== viewport && e.target !== document.getElementById('pdf-container')) return;
        isDown = true;
        startX = e.pageX - viewport.offsetLeft;
        startY = e.pageY - viewport.offsetTop;
        scrollLeft = viewport.scrollLeft;
        scrollTop = viewport.scrollTop;
    });

    viewport.addEventListener('mouseleave', () => isDown = false);
    viewport.addEventListener('mouseup', () => isDown = false);

    viewport.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - viewport.offsetLeft;
        const y = e.pageY - viewport.offsetTop;
        const walkX = (x - startX) * 1.5;
        const walkY = (y - startY) * 1.5;
        viewport.scrollLeft = scrollLeft - walkX;
        viewport.scrollTop = scrollTop - walkY;
    });
}

// --- Drag & Drop into PDF ---
function initDropZone() {
    const container = document.getElementById('pdf-container');
    
    container.addEventListener('dragover', (e) => e.preventDefault());
    container.addEventListener('drop', (e) => {
        e.preventDefault();
        const idx = e.dataTransfer.getData('text/plain');
        const sigData = state.savedSignatures[idx];
        
        const rect = container.getBoundingClientRect();
        const x = (e.clientX - rect.left) / state.zoom;
        const y = (e.clientY - rect.top) / state.zoom;
        
        addSignatureToPage(sigData, x, y);
    });
}

function addSignatureToPage(dataUrl, x, y) {
    const id = Date.now();
    const sig = { id, dataUrl, x: x - 50, y: y - 25, w: 100, h: 50, pageNum: state.currentPage };
    state.activeSignatures.push(sig);
    renderSignatureOverlay(sig);
}

function renderSignatureOverlay(sig) {
    const container = document.getElementById('pdf-container');
    const div = document.createElement('div');
    div.className = 'signature-overlay';
    div.id = `sig-${sig.id}`;
    div.style.width = sig.w + 'px';
    div.style.height = sig.h + 'px';
    div.style.left = sig.x + 'px';
    div.style.top = sig.y + 'px';
    div.innerHTML = `
        <img src="${sig.dataUrl}">
        <div class="delete-sig" onclick="deleteSig(${sig.id})">×</div>
    `;

    container.appendChild(div);

    interact(div)
        .draggable({
            inertia: true,
            listeners: {
                move(event) {
                    sig.x += event.dx;
                    sig.y += event.dy;
                    event.target.style.left = sig.x + 'px';
                    event.target.style.top = sig.y + 'px';
                }
            }
        })
        .resizable({
            edges: { left: true, right: true, bottom: true, top: true },
            listeners: {
                move(event) {
                    sig.x += event.deltaRect.left;
                    sig.y += event.deltaRect.top;
                    sig.w = event.rect.width;
                    sig.h = event.rect.height;

                    Object.assign(event.target.style, {
                        width: `${sig.w}px`,
                        height: `${sig.h}px`,
                        left: `${sig.x}px`,
                        top: `${sig.y}px`
                    });
                }
            }
        });
}

function updateSigsOnDisplay() {
    // Remove all current overlays
    document.querySelectorAll('.signature-overlay').forEach(el => el.remove());
    // Re-render only those for current page
    state.activeSignatures
        .filter(s => s.pageNum === state.currentPage)
        .forEach(s => renderSignatureOverlay(s));
}

function deleteSig(id) {
    state.activeSignatures = state.activeSignatures.filter(s => s.id !== id);
    document.getElementById(`sig-${id}`).remove();
}

// --- Helper: Convert dataUrl to Uint8Array ---
function dataURLtoUint8Array(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// --- Export ---
async function generateSignedPDF() {
    if (!state.pdfBytes) return showToast("No PDF loaded");
    if (state.activeSignatures.length === 0) {
        showToast("Please place at least one signature first");
        return;
    }

    showToast("Generating document...");
    
    try {
        // Use a slice to ensure we have a fresh view of the buffer
        const pdfDoc = await PDFDocument.load(state.pdfBytes.slice(0));
        const pages = pdfDoc.getPages();
        const canvas = document.getElementById('pdf-canvas');

        if (canvas.width === 0 || canvas.height === 0) {
            throw new Error("Preview canvas is not ready. Please ensure the PDF is visible.");
        }

        for (const sig of state.activeSignatures) {
            const page = pages[sig.pageNum - 1];
            const { width, height } = page.getSize();
            
            const resX = width / canvas.width;
            const resY = height / canvas.height;

            const sigImgBytes = dataURLtoUint8Array(sig.dataUrl);
            const sigImg = await pdfDoc.embedPng(sigImgBytes);

            page.drawImage(sigImg, {
                x: sig.x * resX,
                y: height - (sig.y + sig.h) * resY,
                width: sig.w * resX,
                height: sig.h * resY
            });
        }

        const bytes = await pdfDoc.save();
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `signed_pro_${Date.now()}.pdf`;
        document.body.appendChild(a);
        a.click();
        
        // Cleanup
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);

        showToast("Download started!");
    } catch (e) {
        console.error("PDF Generation Error:", e);
        showToast("Error generating PDF: " + e.message);
    }
}

function showToast(m) {
    const t = document.getElementById('toast');
    t.innerText = m;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}
