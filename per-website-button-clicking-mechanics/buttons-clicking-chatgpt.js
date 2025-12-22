'use strict';

async function processChatGPTIncomingMessage(customText, options = {}) {
  const text = customText == null ? "" : String(customText);
  const editorArea = window.ButtonsClickingShared.findEditor();

  if (!editorArea) {
    logConCgp("[chatgpt] Editor not found.");
    return { status: "editor_not_found" };
  }

  const replace = isEditorEmpty(editorArea);
  const inserted = insertTextIntoChatGPTEditor(editorArea, text, replace);
  if (!inserted) {
    return { status: "insert_failed" };
  }

  if (!options.autoSend) {
    return { status: "pasted" };
  }

  return window.ButtonsClickingShared.performAutoSend({
    preClickValidation: () => editorHasContent(editorArea),
    clickAction: (btn) => window.MaxExtensionUtils.simulateClick(btn)
  });
}

function isEditorEmpty(editorElement) {
  if (editorElement instanceof HTMLTextAreaElement) {
    return editorElement.value.trim() === "";
  }

  if (editorElement.isContentEditable || editorElement.getAttribute("contenteditable") === "true") {
    const text = (editorElement.textContent || "").trim();
    const hasPlaceholder = Boolean(editorElement.querySelector("p.placeholder"));
    return text.length === 0 || hasPlaceholder;
  }

  const fallbackText = editorElement.textContent || "";
  return fallbackText.trim() === "";
}

function editorHasContent(editorElement) {
  if (!editorElement) return false;
  if (editorElement instanceof HTMLTextAreaElement) {
    return editorElement.value.trim().length > 0;
  }
  return (editorElement.innerText || editorElement.textContent || "").trim().length > 0;
}

function insertTextIntoChatGPTEditor(editorElement, textToInsert, replace = false) {
  try {
    if (!textToInsert) return true;

    if (editorElement instanceof HTMLTextAreaElement) {
      const existing = replace ? "" : (editorElement.value || "");
      editorElement.focus();
      editorElement.value = existing + textToInsert;
      editorElement.dispatchEvent(new Event("input", { bubbles: true }));
      editorElement.dispatchEvent(new Event("change", { bubbles: true }));
      if (editorElement.setSelectionRange) {
        const end = editorElement.value.length;
        editorElement.setSelectionRange(end, end);
      }
      return true;
    }

    if (editorElement.isContentEditable || editorElement.getAttribute("contenteditable") === "true") {
      editorElement.focus();

      const looksEmpty = (editorElement.textContent || "").trim() === "" || editorElement.querySelector("p.placeholder");
      if (replace && looksEmpty) {
        editorElement.innerHTML = "<p><br></p>";
      }

      if (window.MaxExtensionUtils && typeof window.MaxExtensionUtils.moveCursorToEnd === "function") {
        window.MaxExtensionUtils.moveCursorToEnd(editorElement);
      } else {
        const range = document.createRange();
        range.selectNodeContents(editorElement);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }

      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, textToInsert);
      } catch {
        inserted = false;
      }

      if (!inserted) {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const textNode = document.createTextNode(textToInsert);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        } else {
          editorElement.appendChild(document.createTextNode(textToInsert));
        }
      }

      editorElement.dispatchEvent(new Event("input", { bubbles: true }));
      if (window.MaxExtensionUtils && typeof window.MaxExtensionUtils.moveCursorToEnd === "function") {
        window.MaxExtensionUtils.moveCursorToEnd(editorElement);
      }
      return true;
    }

    const base = replace ? "" : (editorElement.textContent || "");
    editorElement.textContent = base + textToInsert;
    editorElement.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  } catch (err) {
    logConCgp("[chatgpt] insertText failed:", err);
    return false;
  }
}

window.processChatGPTIncomingMessage = processChatGPTIncomingMessage;
