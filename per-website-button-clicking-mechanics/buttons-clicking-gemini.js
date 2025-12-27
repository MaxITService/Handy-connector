'use strict';

/**
 * Processes incoming messages for Google Gemini.
 * Adapted from the user's provided OneClickPrompts logic.
 */
async function processGeminiIncomingMessage(payload, options = {}) {
    const text = payload.text;
    const editorArea = window.ButtonsClickingShared.findEditor();

    if (!editorArea) {
        logConCgp("[gemini] Editor not found.");
        return { status: "editor_not_found" };
    }

    // Text insertion logic for Gemini (Quill-based)
    const inserted = insertTextIntoGeminiEditor(editorArea, text);
    if (!inserted) {
        return { status: "insert_failed" };
    }

    if (!options.autoSend) {
        return { status: "pasted" };
    }

    // Gemini specific auto-send
    return await window.ButtonsClickingShared.performAutoSend({
        preClickValidation: (sendBtn) => {
            return sendBtn && sendBtn.getAttribute('aria-disabled') !== 'true';
        },
        clickAction: (btn) => window.MaxExtensionUtils.simulateClick(btn),
        maxAttempts: 20,
        interval: 150
    });
}

function insertTextIntoGeminiEditor(editor, text) {
    try {
        editor.focus();

        // Clear existing placeholder/content if editor is effectively empty
        const isInitial = editor.classList.contains('ql-blank') || editor.innerHTML === '<p><br></p>';
        const currentText = isInitial ? '' : editor.innerText.trim();
        const newText = `${currentText}${text}`;

        // Set innerHTML - Gemini (Quill) expects paragraphs
        editor.innerHTML = `<p>${newText.replace(/\n/g, '</p><p>')}</p>`;

        // Dispatch events to notify the framework (likely Angular/Quill)
        editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));

        // Move cursor to the end
        window.MaxExtensionUtils.moveCursorToEnd(editor);
        return true;
    } catch (err) {
        logConCgp("[gemini] insertText failed:", err);
        return false;
    }
}

window.processGeminiIncomingMessage = processGeminiIncomingMessage;
