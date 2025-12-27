'use strict';

async function processAIStudioIncomingMessage(payload, options = {}) {
    const text = typeof payload === "string" ? payload : (payload.text || "");
    const editorElement = window.ButtonsClickingShared.findEditor();

    if (!editorElement) {
        logConCgp("[aistudio] Editor not found.");
        return { status: "editor_not_found" };
    }

    const inserted = insertTextIntoAIStudioEditor(editorElement, text);
    if (!inserted) {
        return { status: "insert_failed" };
    }

    if (!options.autoSend) {
        return { status: "pasted" };
    }

    // Short delay to let text settle before auto-send
    await new Promise(r => setTimeout(r, 100));

    return window.ButtonsClickingShared.performAutoSend({
        interval: 200,
        maxAttempts: 10,
        clickAction: (btn) => window.MaxExtensionUtils.simulateClick(btn)
    });
}

function insertTextIntoAIStudioEditor(editorElement, textToInsert) {
    try {
        const text = String(textToInsert || "");
        if (!text) return true;

        // AI Studio uses a textarea
        editorElement.value = editorElement.value + text;

        // Dispatch events for Angular binding
        const events = ["input", "change"];
        events.forEach(eventType => {
            const event = new Event(eventType, { bubbles: true });
            editorElement.dispatchEvent(event);
        });

        // Move cursor to end
        editorElement.setSelectionRange(editorElement.value.length, editorElement.value.length);

        return true;
    } catch (error) {
        logConCgp("[aistudio] Error during text insertion:", error);
        return false;
    }
}

window.processAIStudioIncomingMessage = processAIStudioIncomingMessage;
