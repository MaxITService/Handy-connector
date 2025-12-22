'use strict';

window.ButtonsClickingShared = {
  findEditor() {
    return findFirstVisible(getSelectors("editors"));
  },

  findSendButton() {
    return findFirstVisible(getSelectors("sendButtons"));
  },

  findStopButton() {
    const selectorHit = findFirstVisible(getSelectors("stopButtons"));
    if (selectorHit) return selectorHit;
    return findStopByText();
  },

  async performAutoSend(options = {}) {
    const {
      isEnabled = defaultIsEnabled,
      preClickValidation = () => true,
      clickAction = (btn) => window.MaxExtensionUtils.simulateClick(btn),
      interval = 150,
      maxAttempts = 20
    } = options;

    let sawButton = false;
    let sawDisabled = false;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const stopButton = this.findStopButton();
      if (stopButton) {
        return { status: "busy", button: stopButton };
      }

      const sendButton = this.findSendButton();
      if (sendButton) {
        sawButton = true;
        if (!isEnabled(sendButton)) {
          sawDisabled = true;
        } else if (preClickValidation(sendButton)) {
          clickAction(sendButton);
          return { status: "sent", button: sendButton };
        }
      }

      await sleep(interval);
    }

    if (sawButton && sawDisabled) {
      return { status: "send_not_found", reason: "disabled" };
    }
    if (sawButton) {
      return { status: "send_not_found", reason: "validation_failed" };
    }
    return { status: "send_not_found", reason: "missing" };
  }
};

function getSelectors(key) {
  const selectors = window.InjectionTargetsOnWebsite?.selectors?.[key];
  return Array.isArray(selectors) ? selectors : [];
}

function findFirstVisible(selectors) {
  for (const selector of selectors) {
    if (!selector) continue;
    let nodes = [];
    try {
      nodes = document.querySelectorAll(selector);
    } catch (err) {
      logConCgp("[buttons] Invalid selector skipped:", selector, err?.message || err);
      continue;
    }
    for (const node of nodes) {
      if (window.MaxExtensionUtils.isElementVisible(node)) {
        return node;
      }
    }
  }
  return null;
}

function findStopByText() {
  const candidates = document.querySelectorAll("button, [role=\"button\"]");
  for (const node of candidates) {
    if (!window.MaxExtensionUtils.isElementVisible(node)) continue;
    const text = [
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.getAttribute("data-testid"),
      node.innerText
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (text.includes("stop")) return node;
  }
  return null;
}

function defaultIsEnabled(button) {
  if (!button) return false;
  if (button.disabled) return false;
  const ariaDisabled = button.getAttribute("aria-disabled");
  return ariaDisabled !== "true";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
