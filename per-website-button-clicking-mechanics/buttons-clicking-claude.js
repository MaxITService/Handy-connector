'use strict';

async function processClaudeIncomingMessage(payload, options = {}) {
    const text = typeof payload === "string" ? payload : (payload.text || "");
    const editorElement = window.ButtonsClickingShared.findEditor();

    if (!editorElement) {
        logConCgp("[claude] Editor not found.");
        return { status: "editor_not_found" };
    }

    const inserted = insertTextIntoClaudeEditor(editorElement, text);
    if (!inserted) {
        return { status: "insert_failed" };
    }

    if (!options.autoSend) {
        return { status: "pasted" };
    }

    return window.ButtonsClickingShared.performAutoSend({
        interval: 200,
        maxAttempts: 25,
        clickAction: (btn) => setTimeout(() => window.MaxExtensionUtils.simulateClick(btn), 200)
    });
}

function insertTextIntoClaudeEditor(editorElement, textToInsert) {
    try {
        const text = String(textToInsert || "");
        if (!text) return true;

        editorElement.focus();

        // Check if it's a ProseMirror editor
        const isProseMirror = editorElement.classList.contains("ProseMirror");
        const paragraph = editorElement.querySelector("p");
        const isEmpty = !paragraph || paragraph.classList.contains("is-empty") ||
            paragraph.classList.contains("is-editor-empty") ||
            editorElement.textContent.trim() === "";

        if (isProseMirror) {
            if (isEmpty) {
                editorElement.innerHTML = "<p><br></p>";
            }

            // Set cursor at end
            const selection = window.getSelection();
            selection.removeAllRanges();
            const range = document.createRange();

            const paragraphs = editorElement.querySelectorAll("p");
            const lastParagraph = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : editorElement;
            range.selectNodeContents(lastParagraph);
            range.collapse(false);
            selection.addRange(range);

            // Use execCommand for ProseMirror compatibility
            let inserted = false;
            try {
                inserted = document.execCommand("insertText", false, text);
            } catch {
                inserted = false;
            }

            if (!inserted) {
                const textNode = document.createTextNode(text);
                lastParagraph.appendChild(textNode);
            }

            editorElement.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
            // Standard contenteditable
            const targetElement = paragraph || editorElement;
            if (isEmpty) {
                targetElement.innerHTML = "";
            }
            const textNode = document.createTextNode(text);
            targetElement.appendChild(textNode);
            editorElement.dispatchEvent(new Event("input", { bubbles: true }));
        }

        if (window.MaxExtensionUtils?.moveCursorToEnd) {
            window.MaxExtensionUtils.moveCursorToEnd(editorElement);
        }

        return true;
    } catch (error) {
        logConCgp("[claude] Error during text insertion:", error);
        return false;
    }
}

window.processClaudeIncomingMessage = processClaudeIncomingMessage;
