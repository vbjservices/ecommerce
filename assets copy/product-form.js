if (!customElements.get('product-form')) {
  customElements.define(
    'product-form',
    class ProductForm extends HTMLElement {
      constructor() {
        super();

        this.form = this.querySelector('form');
        this.variantIdInput.disabled = false;
        this.form.addEventListener('submit', this.onSubmitHandler.bind(this));
        this.cart = document.querySelector('cart-notification') || document.querySelector('cart-drawer');
        this.submitButton = this.querySelector('[type="submit"]');
        this.submitButtonText = this.submitButton.querySelector('span');

        if (document.querySelector('cart-drawer')) this.submitButton.setAttribute('aria-haspopup', 'dialog');

        this.hideErrors = this.dataset.hideErrors === 'true';

        this.quantityBreaks = document.getElementById(`quantity-breaks-${this.dataset.sectionId}`);
        this.customFields = document.querySelectorAll(`[id^='CustomField-${this.dataset.sectionId}-']`);
        this.variantInputs = this.form.querySelector(".product-form__variants");
      }

      onSubmitHandler(evt) {
        evt.preventDefault();
        if (this.submitButton.getAttribute('aria-disabled') === 'true') return;

        this.handleErrorMessage();

        this.submitButton.setAttribute('aria-disabled', true);
        this.submitButton.classList.add('loading');
        if(this.querySelector('.loading__spinner')){
          this.querySelector('.loading__spinner').classList.remove('hidden');
        }
        
        let hasVariants = false;
        if (this.quantityBreaks && this.variantInputs && this.quantityBreaks.formVariants?.length > 0) {
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
        const config = fetchConfig('javascript');
        config.headers['X-Requested-With'] = 'XMLHttpRequest';
        delete config.headers['Content-Type'];

        const formData = new FormData(this.form);
        if (this.cart) {
          formData.append(
            'sections',
            this.cart.getSectionsToRender().map((section) => section.id)
          );
          formData.append('sections_url', window.location.pathname);
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
        if (this.form.querySelector("[type=submit]").dataset.skipCart === "true") {
          this.skipCart = true;
        }

        fetch(`${routes.cart_add_url}`, config)
          .then((response) => response.json())
          .then((response) => {
            if (response.status) {
              publish(PUB_SUB_EVENTS.cartError, {
                source: 'product-form',
                productVariantId: formData.get('id'),
                errors: response.errors || response.description,
                message: response.message,
              });
              this.handleErrorMessage(response.description);
            //   if (this.skipCart) {
            //     window.location = "/checkout";
            //     return;
            // }

              const soldOutMessage = this.submitButton.querySelector('.sold-out-message');
              if (!soldOutMessage) return;
              this.submitButton.setAttribute('aria-disabled', true);
              this.submitButtonText.classList.add('hidden');
              soldOutMessage.classList.remove('hidden');
              this.error = true;
              return;
            } else if (!this.cart) {
              window.location = window.routes.cart_url;
              return;
            }else if (this.skipCart) {
                  window.location = "/checkout";
                  return;
              }

            if (!this.error)
              publish(PUB_SUB_EVENTS.cartUpdate, {
                source: 'product-form',
                productVariantId: formData.get('id'),
                cartData: response,
              });
            this.error = false;
            const quickAddModal = this.closest('quick-add-modal');
            if (quickAddModal) {
              document.body.addEventListener(
                'modalClosed',
                () => {
                  setTimeout(() => {
                    this.cart.renderContents(response);
                  });
                },
                { once: true }
              );
              quickAddModal.hide(true);
            } else {
              this.cart.renderContents(response);
            }
          })
          .catch((e) => {
            console.error(e);
          })
          .finally(() => {
            this.submitButton.classList.remove('loading');
            if (this.cart && this.cart.classList.contains('is-empty')) this.cart.classList.remove('is-empty');
            if (!this.error) this.submitButton.removeAttribute('aria-disabled');
            if (this.querySelector('.loading__spinner')){
              this.querySelector('.loading__spinner').classList.add('hidden');
            }
          });
      }

      handleErrorMessage(errorMessage = false) {
        if (this.hideErrors) return;

        this.errorMessageWrapper =
          this.errorMessageWrapper || this.querySelector('.product-form__error-message-wrapper');
        if (!this.errorMessageWrapper) return;
        this.errorMessage = this.errorMessage || this.errorMessageWrapper.querySelector('.product-form__error-message');

        this.errorMessageWrapper.toggleAttribute('hidden', !errorMessage);

        if (errorMessage) {
          this.errorMessage.textContent = errorMessage;
        }
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

      get variantIdInput() {
        return this.form.querySelector('[name=id]');
      }
    }
  );
}
