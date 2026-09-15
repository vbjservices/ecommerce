class PromoPopup {
  constructor(container) {
    this.container = container;
    this.popupModal = container.querySelector(".sign-up-popup-modal");
    this.overlay = container.querySelector(".sign-up-popup-overlay");
    this.closeButton = this.popupModal.querySelector(".popup-modal__close");
    this.dismissButton = this.popupModal.querySelector(
      ".popup-modal__dismiss-btn"
    );

    this.form = this.popupModal.querySelector(".newsletter-form");
    this.emailInput = this.form?.querySelector('input[type="email"]');
    this.submitButton = this.form?.querySelector('button[type="submit"]');
    this.formError = this.form?.querySelector(".newsletter-form__message");

    this.successModal = container.querySelector(".success-popup-modal");
    this.successOverlay = container.querySelector(".success-popup-overlay");
    this.copyButton = this.successModal?.querySelector(
      ".popup-modal__copy-btn"
    );
    this.copySuccessMsg = this.successModal?.querySelector(
      ".popup-modal__success-msg"
    );
    this.successCloseButton = this.successModal?.querySelector(
      ".popup-modal__close"
    );
    this.successDismissButton = this.successModal?.querySelector(
      ".popup-modal__dismiss-btn"
    );

    this.sectionId = this.popupModal.dataset.sectionId;
    this.testMode = this.popupModal.dataset.testMode === "true";
    this.delaySeconds = parseInt(this.popupModal.dataset.delaySeconds);
    this.delayDays = parseInt(this.popupModal.dataset.delayDays);
    this.displayTimer = this.popupModal.dataset.displayTimer === "true";
    this.timerDuration = parseFloat(this.popupModal.dataset.timerDuration) * 60;

    this.minutesElement = this.popupModal.querySelector(
      ".popup-modal__timer__minutes"
    );
    this.secondsElement = this.popupModal.querySelector(
      ".popup-modal__timer__seconds"
    );

    this.storageKey = `promo-popup-${window.location.host}-${this.sectionId}`;

    this.init();
  }

  init() {
    this.setupEventListeners();
    this.checkAndShowPopup();
    if (this.form) {
      this.setupFormSubmission();
    }

    if (this.testMode) {
      if (this.displayTimer) this.startTimer();
      return;
    }
  }

  setupEventListeners() {
    this.closeButton.addEventListener("click", () => this.closePopup());
    if (this.dismissButton) {
      this.dismissButton.addEventListener("click", () => this.closePopup());
    }
    this.overlay.addEventListener("click", () => this.closePopup());

    if (this.successModal) {
      if (this.copyButton) {
        this.copyButton.addEventListener("click", () => this.handleCopyCode());
      }

      if (this.successCloseButton) {
        this.successCloseButton.addEventListener("click", () =>
          this.closeSuccessPopup()
        );
      }
      if (this.successDismissButton) {
        this.successDismissButton.addEventListener("click", () =>
          this.closeSuccessPopup()
        );
      }
      if (this.successOverlay) {
        this.successOverlay.addEventListener("click", () =>
          this.closeSuccessPopup()
        );
      }
    }
  }

  setupFormSubmission() {
    this.submitButton.addEventListener("click", async (e) => {
      e.preventDefault();

      if (!this.emailInput.value) return;

      try {
        this.submitButton.disabled = true;

        localStorage.setItem(
          "promo-bar-subscribed-" + window.location.host,
          JSON.stringify({ subscribed: true })
        );

        this.showSuccessPopup();
      } catch (error) {
        console.error("Error:", error);
        this.showFormError("An error occurred. Please try again.");
      } finally {
        this.submitButton.disabled = false;
      }
    });
  }

  calculateNextDisplayDate() {
    const now = new Date();
    return new Date(
      now.getTime() + this.delayDays * 24 * 60 * 60 * 1000
    ).toISOString();
  }

  checkAndShowPopup() {
    const stored = localStorage.getItem(this.storageKey);

    if (stored) {
      const { next_display_date, dismissed } = JSON.parse(stored);
      const nextDate = new Date(next_display_date);

      if (nextDate > new Date()) {
        return;
      }
    }

    setTimeout(() => {
      this.showPopup();
    }, this.delaySeconds * 1000);
  }

  showPopup() {
    this.popupModal.classList.add("popup-modal--active");
    this.overlay.classList.add("popup-overlay--active");

    if (this.displayTimer) {
      this.startTimer();
    }
  }

  closePopup() {
    this.popupModal.classList.remove("popup-modal--active");
    this.overlay.classList.remove("popup-overlay--active");

    if (!this.testMode) {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({
          next_display_date: this.calculateNextDisplayDate(),
          dismissed: false,
        })
      );
    }
  }

  showSuccessPopup() {
    if (this.successModal) {
      this.closePopup();
      this.successModal.classList.add("popup-modal--active");
      this.successOverlay.classList.add("popup-overlay--active");
    }
  }

  closeSuccessPopup() {
    if (this.successModal) {
      this.successModal.classList.remove("popup-modal--active");
      this.successOverlay.classList.remove("popup-overlay--active");
    }
  }

  async handleCopyCode() {
    if (this.copyButton) {
      const discountCode = this.successModal.querySelector(
        "#DiscountCode--" + this.sectionId
      );

      if (discountCode) {
        console.log("Attempting to copy discount code:", discountCode.value);

        document.body.focus();
        this.copyButton.focus();

        await this.copyToClipboardFallback(discountCode.value);

        if (this.copySuccessMsg) {
          this.copySuccessMsg.style.display = "block";
          setTimeout(() => {
            this.copySuccessMsg.style.display = "none";
          }, 3000);
        }
      } else {
        console.error("Discount code element not found.");
      }
    }
  }

  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      console.log("Text copied successfully!");
    } catch (err) {
      console.error("Failed to copy text using navigator.clipboard:", err);
    }
  }

  copyToClipboardFallback(text) {
    const tempNode = document.createElement("div");
    tempNode.innerHTML = text;

    function listener(e) {
      e.clipboardData.setData("text/html", text);
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
    }
    document.addEventListener("copy", listener);
    document.execCommand("copy");
    document.removeEventListener("copy", listener);
  }
  showFormError(message) {
    if (this.formError) {
      this.formError.textContent = message;
      this.formError.style.display = "block";

      setTimeout(() => {
        this.formError.style.display = "none";
      }, 5000);
    }
  }

  startTimer() {
    let timeLeft = this.timerDuration;

    const updateTimer = () => {
      const minutes = Math.floor(timeLeft / 60);
      const seconds = timeLeft % 60;

      this.minutesElement.textContent = minutes.toString().padStart(2, "0");
      this.secondsElement.textContent = seconds.toString().padStart(2, "0");

      if (timeLeft > 0) {
        timeLeft--;
        setTimeout(updateTimer, 1000);
      } else {
        this.closePopup();
      }
    };

    updateTimer();
  }
}

document.addEventListener("DOMContentLoaded", function () {
  const sections = document.querySelectorAll(
    '[data-section-type="newsletter-popup"]'
  );
  sections.forEach((section) => {
    new PromoPopup(section.closest("section, .shopify-section"));
  });
});
