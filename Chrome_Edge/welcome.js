// Compatibilidad multiplataforma
if (typeof browser !== 'undefined' && typeof chrome === 'undefined') {
    window.chrome = browser;
}

document.addEventListener('DOMContentLoaded', () => {
    const closeBtn = document.getElementById('closeWelcome');
    if (!closeBtn) return;

    closeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        // Guardar onboarding completado y cerrar — único CTA, sin abrir visor/popup
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ welcomeCompleted: true }, () => closeWelcomeTab());
                return;
            }
        } catch (e) {}
        closeWelcomeTab();
    });
});

function closeWelcomeTab() {
    try {
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.getCurrent) {
            chrome.tabs.getCurrent((tab) => {
                if (tab && chrome.tabs.remove) {
                    chrome.tabs.remove(tab.id);
                    return;
                }
                window.close();
            });
            return;
        }
    } catch (error) {
        // Si la API de tabs no esta disponible, intentamos cerrar la ventana directamente.
    }

    window.close();
}
