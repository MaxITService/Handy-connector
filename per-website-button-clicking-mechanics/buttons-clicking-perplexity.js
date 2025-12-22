'use strict';

async function processPerplexityIncomingMessage(customText, options = {}) {
  const text = customText == null ? "" : String(customText);
  const editorElement = window.ButtonsClickingShared.findEditor();

  if (!editorElement) {
    logConCgp("[perplexity] Editor not found.");
    return { status: "editor_not_found" };
  }

  const inserted = insertTextIntoPerplexityEditor(editorElement, text);
  if (!inserted) {
    return { status: "insert_failed" };
  }

  if (!options.autoSend) {
    return { status: "pasted" };
  }

  await sleep(150);

  return window.ButtonsClickingShared.performAutoSend({
    interval: 200,
    maxAttempts: 25,
    isEnabled: isPerplexityButtonEnabled,
    preClickValidation: () => perplexityEditorHasContent(text, editorElement)
  });
}

function insertTextIntoPerplexityEditor(editorElement, textToInsert) {
  try {
    const text = String(textToInsert || "");
    if (!text) return true;

    editorElement.setAttribute("data-hc-target", "true");
    editorElement.setAttribute("data-hc-text", text);

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("per-website-button-clicking-mechanics/perplexity-injector.js");
    script.onload = () => script.remove();
    script.onerror = () => {
      logConCgp("[perplexity] Failed to load injector script.");
      script.remove();
    };
    (document.head || document.documentElement).appendChild(script);

    if (window.MaxExtensionUtils && typeof window.MaxExtensionUtils.moveCursorToEnd === "function") {
      setTimeout(() => window.MaxExtensionUtils.moveCursorToEnd(editorElement), 50);
    }

    return true;
  } catch (error) {
    logConCgp("[perplexity] Error during text insertion:", error);
    return false;
  }
}

function isPerplexityButtonEnabled(button) {
  if (!button) return false;
  const ariaDisabled = button.getAttribute("aria-disabled");
  const dataDisabled = button.getAttribute("data-disabled");
  if (button.disabled || ariaDisabled === "true" || dataDisabled === "true") {
    return false;
  }
  const styleOpacity = window.getComputedStyle(button).opacity;
  if (styleOpacity && Number(styleOpacity) < 0.2) {
    return false;
  }
  return true;
}

function perplexityEditorHasContent(expectedText, editorElement) {
  try {
    if (!editorElement) return false;
    const currentText = editorElement.innerText || editorElement.textContent || "";
    const normalizedCurrent = currentText.replace(/\s+/g, "").toLowerCase();

    if (expectedText) {
      const normalizedExpected = expectedText.replace(/\s+/g, "").toLowerCase();
      const probe = normalizedExpected.slice(0, 30);
      if (probe && normalizedCurrent.includes(probe)) {
        return true;
      }
    }

    return normalizedCurrent.length > 0;
  } catch (error) {
    logConCgp("[perplexity] Error while verifying editor content:", error);
    return true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

window.processPerplexityIncomingMessage = processPerplexityIncomingMessage;
