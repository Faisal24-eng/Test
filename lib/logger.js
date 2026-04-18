// ================================================
// NEXUS TRADING TERMINAL - LOGGING UTILITY
// Configurable debug levels for production/development
// ================================================

/**
 * Log levels from least to most verbose
 */
const LogLevel = {
    OFF: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4,
    TRACE: 5
};

/**
 * Logger class with configurable levels
 */
class Logger {
    constructor(prefix = 'Nexus') {
        this.prefix = prefix;
        this.level = LogLevel.INFO; // Default level
        this.timestamps = true;
        this.colorEnabled = true;
        
        // Load saved log level from storage
        this.loadLevel();
    }

    /**
     * Load log level from chrome storage
     */
    async loadLevel() {
        try {
            const stored = localStorage.getItem('nexus_logLevel');
            if (stored !== null) {
                this.level = parseInt(stored, 10);
            }
        } catch (e) {
            // Silently fail - use default level
        }
    }

    /**
     * Set log level and persist to storage
     * @param {number} level - Log level from LogLevel enum
     */
    async setLevel(level) {
        this.level = level;
        try {
            localStorage.setItem('nexus_logLevel', level.toString());
        } catch (e) {
            // Silently fail
        }
    }

    /**
     * Format timestamp
     */
    getTimestamp() {
        if (!this.timestamps) return '';
        const now = new Date();
        return `[${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
    }

    /**
     * Format log message with prefix
     */
    formatMessage(level, ...args) {
        const timestamp = this.getTimestamp();
        const prefix = `[${this.prefix}]`;
        return [timestamp, prefix, `[${level}]`, ...args].filter(Boolean);
    }

    /**
     * Error level logging - always shown unless OFF
     */
    error(...args) {
        if (this.level >= LogLevel.ERROR) {
            console.error(...this.formatMessage('ERROR', ...args));
        }
    }

    /**
     * Warning level logging
     */
    warn(...args) {
        if (this.level >= LogLevel.WARN) {
            console.warn(...this.formatMessage('WARN', ...args));
        }
    }

    /**
     * Info level logging - general operational messages
     */
    info(...args) {
        if (this.level >= LogLevel.INFO) {
            console.info(...this.formatMessage('INFO', ...args));
        }
    }

    /**
     * Debug level logging - detailed debugging info
     */
    debug(...args) {
        if (this.level >= LogLevel.DEBUG) {
            console.log(...this.formatMessage('DEBUG', ...args));
        }
    }

    /**
     * Trace level logging - very verbose, performance-impacting
     */
    trace(...args) {
        if (this.level >= LogLevel.TRACE) {
            console.log(...this.formatMessage('TRACE', ...args));
        }
    }

    /**
     * Log with specific level
     */
    log(level, ...args) {
        switch (level) {
            case LogLevel.ERROR: this.error(...args); break;
            case LogLevel.WARN: this.warn(...args); break;
            case LogLevel.INFO: this.info(...args); break;
            case LogLevel.DEBUG: this.debug(...args); break;
            case LogLevel.TRACE: this.trace(...args); break;
        }
    }

    /**
     * Create a child logger with a sub-prefix
     * @param {string} subPrefix - Additional prefix for the child logger
     */
    child(subPrefix) {
        const childLogger = new Logger(`${this.prefix}:${subPrefix}`);
        childLogger.level = this.level;
        childLogger.timestamps = this.timestamps;
        return childLogger;
    }

    /**
     * Group logs together (collapsible in console)
     */
    group(label, fn) {
        if (this.level >= LogLevel.DEBUG) {
            console.group(...this.formatMessage('GROUP', label));
            try {
                fn();
            } finally {
                console.groupEnd();
            }
        } else {
            fn();
        }
    }

    /**
     * Time a function execution
     */
    async time(label, fn) {
        if (this.level >= LogLevel.DEBUG) {
            const start = performance.now();
            try {
                return await fn();
            } finally {
                const duration = performance.now() - start;
                this.debug(`${label} took ${duration.toFixed(2)}ms`);
            }
        } else {
            return await fn();
        }
    }

    /**
     * Log object as table
     */
    table(data, label = '') {
        if (this.level >= LogLevel.DEBUG) {
            if (label) this.debug(label);
            console.table(data);
        }
    }
}

// Singleton instance for general use
const logger = new Logger('Nexus');

// Named loggers for different modules
const createModuleLogger = (moduleName) => logger.child(moduleName);

export { Logger, LogLevel, logger, createModuleLogger };
export default logger;
