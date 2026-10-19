/**
 * 0xDEADBYTE - Client-Side Interactive Engine & Secure Terminal Sandbox
 * Refactored under OWASP Top 10 & AppSec Guidelines.
 */

// Text Scramble / Decoding Effect
const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*';

/**
 * Glitch / Text Scramble Effect — Page Load, Scroll, Touch & Hover Support
 * @param {HTMLElement} element - The element to animate
 */
function triggerGlitch(element) {
    if (!element) return;
    const targetText = element.getAttribute('data-value') || element.textContent.trim();
    element.setAttribute('data-value', targetText);

    if (element.glitchInterval) {
        clearInterval(element.glitchInterval);
    }

    let iteration = 0;
    element.glitchInterval = setInterval(() => {
        element.textContent = targetText
            .split("")
            .map((letter, index) => {
                if (index < iteration || letter === ' ' || letter === '_') {
                    return targetText[index];
                }
                return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
            })
            .join("");

        if (iteration >= targetText.length) {
            clearInterval(element.glitchInterval);
        }

        iteration += 1 / 3;
    }, 28);
}

function initGlitchAnimation(element) {
    if (!element) return;

    // Hover for desktop
    element.addEventListener('mouseenter', () => triggerGlitch(element));
    
    // Touch/Click for mobile
    element.addEventListener('touchstart', () => triggerGlitch(element), { passive: true });
    element.addEventListener('click', () => triggerGlitch(element));

    // IntersectionObserver to auto-scramble when element scrolls into view!
    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !element.hasAnimated) {
                    element.hasAnimated = true;
                    setTimeout(() => triggerGlitch(element), 150);
                }
            });
        }, { threshold: 0.2 });
        observer.observe(element);
    } else {
        setTimeout(() => triggerGlitch(element), 300);
    }
}

function autoInitGlitches() {
    const glitchElements = document.querySelectorAll('.glitch-text');
    glitchElements.forEach(el => initGlitchAnimation(el));
}

// Initial run & event listener for dynamic updates
autoInitGlitches();
window.addEventListener('contentUpdated', autoInitGlitches);

// ------------------------------------------------------------------------------
// Terminal Sandbox (Strict Client-Side Execution Only - Zero Remote Shell/Eval)
// ------------------------------------------------------------------------------
const terminalInput = document.getElementById('terminalInput');
const terminalOutput = document.getElementById('terminalOutput');
const terminalContainer = document.getElementById('terminal');

if (terminalInput && terminalOutput) {
    // Whitelisted Command Handlers (Client-side Closed Sandbox)
    const COMMANDS = {
        help: () => `AVAILABLE COMMANDS:
help     - Show list of supported commands
email    - Display contact details
social   - List official social profiles
projects - List verified open-source projects
clear    - Clear terminal screen
whoami   - Display current session profile`,

        email: () => 'Contact Email: muhammedfatihozturk01@gmail.com',

        social: () => `OFFICIAL PROFILES:
- GitHub:   https://github.com/ParanoidNull
- LinkedIn: https://linkedin.com/in/muhammedfatihöztürk`,

        projects: () => `VERIFIED MODULES:
- Anti-Virus Evasion Toolkit [C/C++]
- Defensive SIEM Alerting Pipeline [Python/ELK]
- Web Hardening Framework [.htaccess/Nginx]`,

        clear: () => {
            // OWASP A03 Mitigation: Replace innerHTML with replaceChildren
            terminalOutput.replaceChildren();
            return null;
        },

        whoami: () => 'Identity: Muhammed_Fatih_Öztürk (Security Researcher & Developer)'
    };

    /**
     * Safely appends a line to the terminal output using strict text node encoding.
     * @param {string} text - Text to display
     * @param {boolean} isCommand - True if text is user command prompt
     */
    function addTerminalLine(text, isCommand = false) {
        const line = document.createElement('div');
        line.className = 'terminal-line';

        const promptSpan = document.createElement('span');
        promptSpan.className = 'terminal-prompt';
        promptSpan.textContent = 'guest@system:~$';

        if (isCommand) {
            const textSpan = document.createElement('span');
            textSpan.className = 'terminal-text';
            textSpan.textContent = text; // Safe text node assignment (XSS Proof)
            
            line.appendChild(promptSpan);
            line.appendChild(textSpan);
            terminalOutput.appendChild(line);
        } else {
            const lines = text.split('\n');
            lines.forEach((lineText, index) => {
                const rowLine = document.createElement('div');
                rowLine.className = 'terminal-line';

                const rowTextSpan = document.createElement('span');
                rowTextSpan.className = 'terminal-text';
                rowTextSpan.textContent = lineText;

                if (index === 0) {
                    rowLine.appendChild(promptSpan);
                }
                rowLine.appendChild(rowTextSpan);
                terminalOutput.appendChild(rowLine);
            });
        }

        // Auto-scroll terminal to bottom
        terminalOutput.scrollTop = terminalOutput.scrollHeight;
    }

    terminalInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const rawValue = terminalInput.value;
            // Input sanitization: Trim space & strip control characters
            const sanitizedCommand = rawValue.trim().toLowerCase();

            // Display executed command
            addTerminalLine(rawValue, true);
            terminalInput.value = '';

            if (!sanitizedCommand) return;

            if (Object.prototype.hasOwnProperty.call(COMMANDS, sanitizedCommand)) {
                const outputResult = COMMANDS[sanitizedCommand]();
                if (outputResult !== null) {
                    addTerminalLine(outputResult, false);
                }
            } else {
                // Strict output encoding for unknown command response
                addTerminalLine(`Command not found: ${sanitizedCommand}. Type 'help' for available commands.`, false);
            }
        }
    });

    if (terminalContainer) {
        terminalContainer.addEventListener('click', () => {
            terminalInput.focus();
        });
    }
}
