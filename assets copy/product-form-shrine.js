customElements.get("product-form") || customElements.define("product-form", class extends HTMLElement {
    constructor() {
        super();
        this.form = this.querySelector("form");
        this.formIdInput = this.form.querySelector("[name=id]");
        this.formIdInput.disabled = false;
        this.form.addEventListener("submit", this.onSubmitHandler.bind(this));
        this.cart = document.querySelector("cart-notification") || document.querySelector("cart-drawer");
        this.submitButton = this.querySelector('[type="submit"]');
        this.stickyAtcButton = document.getElementById(`StickyAtcSubmitButton-${this.dataset.section}`);
        if (document.querySelector("cart-drawer")) {
            this.submitButton.setAttribute("aria-haspopup", "dialog");
        }
        this.bundleDeals = document.getElementById(`bundle-deals-${this.dataset.section}`);
        this.quantityBreaks = document.getElementById(`quantity-breaks-${this.dataset.section}`);
        this.customFields = document.querySelectorAll(`[id^='CustomField-${this.dataset.section}-']`);
        this.variantInputs = this.form.querySelector(".product-form__variants");
    }
  
    onSubmitHandler(event) {
        event.preventDefault();
        if (this.submitButton.getAttribute("aria-disabled") === "true") return;
  
        this.handleErrorMessage();
        this.submitButton.setAttribute("aria-disabled", true);
        this.submitButton.classList.add("loading");
  
        if (this.querySelector(".loading-overlay__spinner")) {
            this.querySelector(".loading-overlay__spinner").classList.remove("hidden");
        }
  
        if (this.stickyAtcButton) {
            this.stickyAtcButton.classList.add("loading");
            this.stickyAtcButton.querySelector(".loading-overlay__spinner").classList.remove("hidden");
        }
  
        let hasVariants = false;
        if (this.variantInputs) {
            this.variantInputs.innerHTML = "";
        }
  
        if (this.bundleDeals) {
            let bundleInputs = "";
            hasVariants = true;
            for (let i = 0; i < this.bundleDeals.formVariants.length; i++) {
                let variant = this.bundleDeals.formVariants[i];
                bundleInputs += `<input type="hidden" name="items[${i}][quantity]" value="${variant.quantity}">`;
                bundleInputs += `<input type="hidden" name="items[${i}][id]" value="${variant.id}">`;
            }
            this.variantInputs.innerHTML = bundleInputs;
        } else if (this.quantityBreaks && this.variantInputs && this.quantityBreaks.formVariants.length > 0) {
            let quantityInputs = "";
            hasVariants = true;
            for (let i = 0; i < this.quantityBreaks.formVariants.length; i++) {
                let variant = this.quantityBreaks.formVariants[i];
                quantityInputs += `<input type="hidden" name="items[${i}][quantity]" value="${variant.quantity}">`;
                quantityInputs += `<input type="hidden" name="items[${i}][id]" value="${variant.id}">`;
                this.customFields.forEach(field => {
                    quantityInputs += `<input type="hidden" name="items[${i}][properties][${field.fieldName}]" value="${field.value}">`;
                });
            }
            this.variantInputs.innerHTML = quantityInputs;
        }
  
        let config = fetchConfig("javascript");
        config.headers["X-Requested-With"] = "XMLHttpRequest";
        delete config.headers["Content-Type"];
  
        let formData = new FormData(this.form);
        if (this.cart) {
            formData.append("sections", this.cart.getSectionsToRender().map(section => section.id));
            formData.append("sections_url", window.location.pathname);
            this.cart.setActiveElement(document.activeElement);
        }
  
        if (hasVariants) {
            let options = this.dataset.options ? this.dataset.options.split(",") : [];
            let fieldsToDelete = ["id", "quantity", ...options];
            for (let field of fieldsToDelete) {
                formData.delete(field);
            }
        }
  
        config.body = formData;
        this.skipCart = false;
        if (this.form.querySelector("[name=id]").dataset.skipCart === "true") {
            this.skipCart = true;
        }
  
        fetch(`${routes.cart_add_url}`, config)
            .then(response => response.json())
            .then(data => {
                if (data.status) {
                    this.handleErrorMessage(data.description);
                    let soldOutMessage = this.submitButton.querySelector(".sold-out-message");
                    if (!soldOutMessage) return;
                    this.submitButton.setAttribute("aria-disabled", true);
                    this.submitButton.querySelector("span").classList.add("hidden");
                    soldOutMessage.classList.remove("hidden");
                    this.error = true;
                    return;
                }
  
                if (this.skipCart) {
                    window.location = "/checkout";
                    return;
                }
  
                if (!this.cart) {
                    window.location = window.routes.cart_url;
                    return;
                }
  
                if (!this.error) {
                    publish(PUB_SUB_EVENTS.cartUpdate, { source: "product-form" });
                }
  
                this.error = false;
                let quickAddModal = this.closest("quick-add-modal");
                if (quickAddModal) {
                    document.body.addEventListener("modalClosed", () => {
                        setTimeout(() => {
                            this.cart.renderContents(data);
                        });
                    }, { once: true });
                    quickAddModal.hide(true);
                } else {
                    this.cart.renderContents(data);
                }
            })
            .catch(error => {
                console.error(error);
            })
            .finally(() => {
                this.submitButton.classList.remove("loading");
                if(this.querySelector(".loading-overlay__spinner")){
  
                  this.querySelector(".loading-overlay__spinner").classList.add("hidden");
                }
                if (this.stickyAtcButton) {
                    this.stickyAtcButton.classList.remove("loading");
                    this.stickyAtcButton.querySelector(".loading-overlay__spinner").classList.add("hidden");
                }
                if (this.cart && this.cart.classList.contains("is-empty")) {
                    this.cart.classList.remove("is-empty");
                }
                if (!this.error) {
                    this.submitButton.removeAttribute("aria-disabled");
                }
            });
    }
    toggleSubmitButton(disable = true, text) {
      if (disable) {
        this.submitButton.setAttribute('disabled', 'disabled');
        if (text) this.submitButtonText.textContent = text;
      } else {
        this.submitButton.removeAttribute('disabled');
        this.submitButtonText.textContent = window.variantStrings.addToCart;
      }
    }
  
    handleErrorMessage(message = false) {
        this.errorMessageWrapper = this.errorMessageWrapper || this.querySelector(".product-form__error-message-wrapper");
        if (this.errorMessageWrapper) {
            this.errorMessage = this.errorMessage || this.errorMessageWrapper.querySelector(".product-form__error-message");
            this.errorMessageWrapper.toggleAttribute("hidden", !message);
            if (message) {
                this.errorMessage.textContent = message;
            }
        }
    }
  });