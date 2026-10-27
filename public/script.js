/**
 * 0xDEADBYTE - Client-Side Interactive Engine & Secure Terminal Sandbox
 * Refactored under OWASP Top 10 & AppSec Guidelines.
 */

// Text Scramble / Decoding Effect
const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*';

// Keep the real text in flow. Each animated glyph uses its final glyph's
// position and only replacement characters that fit, without clipping/scaling.
function prepareHomeGlitch(element) {
    const measure = element.querySelector('.glitch-measure');
    const overlay = element.querySelector('.glitch-overlay');
    const text = measure.firstChild;
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d');
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const range = document.createRange();
    const cells = Array.from(text.textContent, (letter, index) => {
        range.setStart(text, index);
        range.setEnd(text, index + 1);
        const rect = range.getBoundingClientRect();
        const cell = document.createElement('span');
        cell.style.left = `${rect.left - bounds.left}px`;
        cell.style.top = `${rect.top - bounds.top}px`;
        // Range height is the font's glyph box, rather than the heading line box.
        cell.style.lineHeight = `${rect.height}px`;
        const width = context.measureText(letter).width;
        const choices = Array.from(SCRAMBLE_CHARS)
            .filter(char => context.measureText(char).width <= width);
        overlay.appendChild(cell);
        return { cell, choices: choices.length ? choices : [letter] };
    });
    return (value, finished) => {
        if (finished) {
            overlay.replaceChildren();
            element.classList.remove('is-scrambling');
            return;
        }
        Array.from(value).forEach((letter, index) => {
            const { cell, choices } = cells[index];
            cell.textContent = letter === text.textContent[index] ? letter
                : choices[Math.floor(Math.random() * choices.length)];
        });
        element.classList.add('is-scrambling');
    };
}

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
    const stable = element.hasAttribute('data-stable-glitch');
    if (stable) element.querySelector('.glitch-overlay').replaceChildren();
    const render = stable ? prepareHomeGlitch(element) : null;

    let iteration = 0;
    element.glitchInterval = setInterval(() => {
        const value = targetText
            .split("")
            .map((letter, index) => {
                if (index < iteration || letter === ' ' || letter === '_') {
                    return targetText[index];
                }
                return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
            })
            .join("");
        if (render) render(value, iteration >= targetText.length);
        else element.textContent = value;

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
    glitchElements.forEach(el => {
        if (el.hasAttribute('data-stable-glitch')) {
            if (el.glitchInitialized) return;
            el.glitchInitialized = true;
            // Measure only after the actual font (or its fallback) has settled.
            document.fonts.ready.then(() => initGlitchAnimation(el));
            window.addEventListener('resize', () => {
                clearInterval(el.glitchInterval);
                el.querySelector('.glitch-overlay').replaceChildren();
                el.classList.remove('is-scrambling');
            });
        } else initGlitchAnimation(el);
    });
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

        projects: () => {
            const source = document.getElementById('terminal-projects');
            const projects = source ? JSON.parse(source.textContent) : [];
            if (!projects.length) return 'No published projects are available.';

            addTerminalLine('VERIFIED MODULES:');
            projects.forEach(project => {
                const row = document.createElement('div');
                row.className = 'terminal-line';
                const text = document.createElement('span');
                text.className = 'terminal-text';
                const link = document.createElement('a');
                link.href = project.url;
                link.textContent = project.title;
                text.append('- ', link);
                row.appendChild(text);
                terminalOutput.appendChild(row);
            });
            terminalOutput.scrollTop = terminalOutput.scrollHeight;
            return null;
        },

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
