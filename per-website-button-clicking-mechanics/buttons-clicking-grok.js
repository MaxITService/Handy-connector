'use strict';

async function processGrokIncomingMessage(payload, options = {}) {
    const text = typeof payload === "string" ? payload : (payload.text || "");
    const editorElement = window.ButtonsClickingShared.findEditor();

    if (!editorElement) {
        logConCgp("[grok] Editor not found.");
        return { status: "editor_not_found" };
    }

    const inserted = await insertTextIntoGrokEditor(editorElement, text);
    if (!inserted) {
        return { status: "insert_failed" };
    }

    if (!options.autoSend) {
        return { status: "pasted" };
    }

    // Short delay before auto-send
    await new Promise(r => setTimeout(r, 100));

    return window.ButtonsClickingShared.performAutoSend({
        interval: 200,
        maxAttempts: 25,
        preClickValidation: () => {
            const isTextArea = editorElement.value !== undefined;
            const currentText = isTextArea ? editorElement.value.trim() : editorElement.innerText.trim();
            return currentText.length > 0;
        },
        clickAction: (btn) => window.MaxExtensionUtils.simulateClick(btn)
    });
}

async function insertTextIntoGrokEditor(editorElement, textToInsert) {
    try {
        const text = String(textToInsert || "");
        if (!text) return true;

        const isTextArea = editorElement.value !== undefined;

        editorElement.focus();

        if (isTextArea) {
            // For textarea elements
            editorElement.value = editorElement.value + text;
            editorElement.dispatchEvent(new Event("input", { bubbles: true }));
            editorElement.dispatchEvent(new Event("change", { bubbles: true }));
            editorElement.setSelectionRange(editorElement.value.length, editorElement.value.length);
        } else {
            // For contenteditable elements
            editorElement.innerText = editorElement.innerText + text;
            editorElement.dispatchEvent(new Event("input", { bubbles: true }));
            if (window.MaxExtensionUtils?.moveCursorToEnd) {
                window.MaxExtensionUtils.moveCursorToEnd(editorElement);
            }
        }

        // Simulate a final keystroke for the last character to trigger auto-resize (Grok-specific)
        await simulateGrokLastKeystroke(editorElement, text.slice(-1), isTextArea);

        return true;
    } catch (error) {
        logConCgp("[grok] Error during text insertion:", error);
        return false;
    }
}

async function simulateGrokLastKeystroke(editorElement, char, isTextArea) {
    const eventTypes = ["keydown", "input", "keyup"];
    for (const type of eventTypes) {
        let evt;
        if (type === "input") {
            evt = new InputEvent(type, {
                data: char,
                inputType: "insertText",
                bubbles: true,
                cancelable: true
            });
        } else {
            evt = new KeyboardEvent(type, {
                key: char,
                code: `Key${char.toUpperCase()}`,
                bubbles: true,
                cancelable: true
            });
        }
        editorElement.dispatchEvent(evt);
    }
    await new Promise(r => setTimeout(r, 50));
}

window.processGrokIncomingMessage = processGrokIncomingMessage;
