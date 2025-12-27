'use strict';

window.MaxExtensionUtils = {
  simulateClick(element) {
    const event = new MouseEvent("click", {
      view: window,
      bubbles: true,
      cancelable: true,
      buttons: 1
    });
    element.dispatchEvent(event);
    logConCgp("[utils] simulateClick: Click event dispatched.", element);
  },

  moveCursorToEnd(contentEditableElement) {
    contentEditableElement.focus();
    if (typeof window.getSelection === "undefined" || typeof document.createRange === "undefined") {
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(contentEditableElement);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  },

  isElementVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(element);
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden") return false;
    const opacity = Number.parseFloat(style.opacity || "1");
    if (!Number.isNaN(opacity) && opacity === 0) return false;
    return true;
  }
};

class InjectionTargetsOnWebsite {
  constructor() {
    this.activeSite = this.identifyActiveWebsite();
    this.selectors = this.getDefaultSelectors(this.activeSite);
  }

  identifyActiveWebsite() {
    const currentHostname = window.location.hostname;
    if (currentHostname.includes("chat.openai.com") || currentHostname.includes("chatgpt.com")) {
      return "ChatGPT";
    }
    if (currentHostname.includes("perplexity.ai")) {
      return "Perplexity";
    }
    if (currentHostname.includes("gemini.google.com")) {
      return "Gemini";
    }
    if (currentHostname.includes("claude.ai")) {
      return "Claude";
    }
    if (currentHostname.includes("grok.com") || currentHostname.includes("x.com/i/grok")) {
      return "Grok";
    }
    if (currentHostname.includes("aistudio.google.com")) {
      return "AIStudio";
    }
    return "Unknown";
  }

  getDefaultSelectors(site) {
    const selectors = {
      ChatGPT: {
        sendButtons: [
          "button[aria-label=\"Send message\"]",
          "button[data-testid=\"send-button\"]",
          "button[type=\"submit\"]"
        ],
        editors: [
          "div.ProseMirror#prompt-textarea[contenteditable=\"true\"]",
          "div.ProseMirror[contenteditable=\"true\"]",
          "div[contenteditable=\"true\"].ProseMirror",
          "div.ProseMirror",
          "textarea"
        ],
        stopButtons: [
          "button[data-testid=\"stop-button\"]",
          "button[aria-label=\"Stop generating\"]"
        ]
      },
      Perplexity: {
        sendButtons: [
          "button[data-testid=\"submit-button\"][aria-label=\"Submit\"]",
          "button[data-testid=\"submit-button\"]",
          "button[type=\"button\"][aria-label=\"Submit\"]",
          "button[aria-label=\"Submit\"]"
        ],
        editors: [
          "div#ask-input[contenteditable=\"true\"]",
          "div[contenteditable=\"true\"][data-lexical-editor=\"true\"]",
          "div[contenteditable=\"true\"]"
        ],
        stopButtons: [
          "button[aria-label=\"Stop\"]",
          "button[data-testid=\"stop-button\"]"
        ]
      },
      Gemini: {
        sendButtons: [
          "button[aria-label=\"Send message\"]",
          "button[data-testid=\"send-button\"]",
          "div.send-button-container button"
        ],
        editors: [
          "div[contenteditable=\"true\"].ql-editor",
          "div[contenteditable=\"true\"]",
          ".ql-editor"
        ],
        stopButtons: [
          "button[aria-label=\"Stop generating\"]",
          "button[data-testid=\"stop-button\"]"
        ]
      },
      Claude: {
        sendButtons: [
          "button[aria-label=\"Send Message\"]",
          "button[aria-label=\"Send message\"]",
          "fieldset button[type=\"button\"]"
        ],
        editors: [
          "div.ProseMirror[contenteditable=\"true\"]",
          "div[contenteditable=\"true\"].ProseMirror",
          "div[contenteditable=\"true\"]"
        ],
        stopButtons: [
          "button[aria-label=\"Stop Response\"]",
          "button[aria-label=\"Stop response\"]"
        ]
      },
      Grok: {
        sendButtons: [
          "button[aria-label=\"Submit\"]",
          "button[type=\"submit\"]"
        ],
        editors: [
          "textarea[placeholder*=\"Ask\"]",
          "textarea",
          "div[contenteditable=\"true\"]"
        ],
        stopButtons: [
          "button[aria-label=\"Stop\"]",
          "button[aria-label=\"Stop generating\"]"
        ]
      },
      AIStudio: {
        sendButtons: [
          "button[aria-label=\"Run\"]",
          "button[mattooltip=\"Run\"]",
          "button.run-button"
        ],
        editors: [
          "textarea.prompt-textarea",
          "textarea[aria-label*=\"prompt\"]",
          "textarea"
        ],
        stopButtons: [
          "button[aria-label=\"Stop\"]"
        ]
      }
    };
    const defaults = selectors[site];
    return defaults ? defaults : { sendButtons: [], editors: [], stopButtons: [] };
  }
}

window.InjectionTargetsOnWebsite = new InjectionTargetsOnWebsite();
