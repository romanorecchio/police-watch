/** Web Speech API queue, tuned for iOS Safari / Home Screen PWAs.
 *  The first audible utterance MUST run in the same user-tap call stack.
 */

export function createSpeaker() {
  const state = {
    enabled: true,
    unlocked: false,
    speaking: false,
    queue: [],
    lastText: "",
    lastAt: 0,
    resumeTimer: null,
  };

  function supported() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  function pickVoice() {
    if (!supported()) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    const preferred = voices.find((v) => /en-US/i.test(v.lang) && /Samantha|Siri|Ava|Susan/i.test(v.name))
      || voices.find((v) => /en-US/i.test(v.lang) && /Google US English|Enhanced/i.test(v.name))
      || voices.find((v) => /en-US/i.test(v.lang))
      || voices.find((v) => /^en/i.test(v.lang));
    return preferred || null;
  }

  function applyVoice(utterance) {
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    utterance.lang = (voice && voice.lang) || "en-US";
    utterance.rate = 1.0;
    utterance.pitch = 1;
    utterance.volume = 1;
  }

  function startResumeWatch() {
    if (state.resumeTimer || !supported()) return;
    // iOS Safari pauses speechSynthesis when it thinks the page is idle.
    state.resumeTimer = setInterval(() => {
      if (!state.enabled || !supported()) return;
      try {
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
          window.speechSynthesis.resume();
        }
      } catch {}
    }, 4000);
  }

  function stopResumeWatch() {
    if (state.resumeTimer) {
      clearInterval(state.resumeTimer);
      state.resumeTimer = null;
    }
  }

  /**
   * Call this directly from a tap/click handler (no await beforehand).
   * A silent utterance does not unlock iOS; this speaks a real phrase.
   */
  function unlock(phrase = "Police Watch started.") {
    if (!supported()) return false;
    startResumeWatch();
    try {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.cancel();
      state.speaking = false;
      state.queue.length = 0;
      if (!state.enabled) {
        state.unlocked = true;
        return true;
      }
      const u = new SpeechSynthesisUtterance(phrase);
      applyVoice(u);
      u.onend = () => {
        state.speaking = false;
        setTimeout(next, 200);
      };
      u.onerror = () => {
        state.speaking = false;
        setTimeout(next, 200);
      };
      state.speaking = true;
      state.lastText = phrase;
      state.lastAt = Date.now();
      window.speechSynthesis.speak(u);
      state.unlocked = true;
      return true;
    } catch {
      return false;
    }
  }

  function next() {
    if (!state.enabled || !supported()) {
      state.queue.length = 0;
      return;
    }
    if (state.speaking) return;
    const item = state.queue.shift();
    if (!item) return;
    state.speaking = true;
    const u = new SpeechSynthesisUtterance(item.text);
    applyVoice(u);
    u.onend = () => {
      state.speaking = false;
      setTimeout(next, 250);
    };
    u.onerror = () => {
      state.speaking = false;
      setTimeout(next, 250);
    };
    try {
      window.speechSynthesis.speak(u);
      try { window.speechSynthesis.resume(); } catch {}
    } catch {
      state.speaking = false;
    }
  }

  function speak(text, { uniqueWindowMs = 8000 } = {}) {
    if (!state.enabled || !text) return false;
    const now = Date.now();
    if (text === state.lastText && now - state.lastAt < uniqueWindowMs) return false;
    state.lastText = text;
    state.lastAt = now;
    if (!supported()) return false;
    if (!state.unlocked) {
      // Still queue, but iOS will stay silent until unlock() runs from a tap.
      state.queue.push({ text });
      return false;
    }
    state.queue.push({ text });
    next();
    return true;
  }

  function setEnabled(on) {
    state.enabled = !!on;
    if (!on && supported()) {
      state.queue.length = 0;
      window.speechSynthesis.cancel();
      state.speaking = false;
      stopResumeWatch();
    } else if (on) {
      startResumeWatch();
    }
  }

  if (typeof window !== "undefined" && supported()) {
    window.speechSynthesis.addEventListener?.("voiceschanged", () => pickVoice());
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && supported() && state.enabled) {
        try { window.speechSynthesis.resume(); } catch {}
        if (!window.speechSynthesis.speaking) {
          state.speaking = false;
          next();
        }
      }
    });
  }

  return { unlock, speak, setEnabled, supported, state };
}
