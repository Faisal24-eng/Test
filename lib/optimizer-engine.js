// ================================================
// NEXUS TRADING TERMINAL - OPTIMIZER ENGINE
// Hyper-speed grid search for best AI parameters
// ================================================

import backtester from './backtester.js';

class OptimizerEngine {
    constructor() {
        this.isRunning = false;
        this.progress = 0;
        this.results = [];
        this.totalCombinations = 0;
        this.currentCombination = 0;
    }

    /**
     * Generate all possible combinations from parameter ranges
     */
    generateGrid(ranges) {
        const keys = Object.keys(ranges);
        const combinations = [];

        function helper(current, depth) {
            if (depth === keys.length) {
                combinations.push({ ...current });
                return;
            }
            const key = keys[depth];
            for (const value of ranges[key]) {
                current[key] = value;
                helper(current, depth + 1);
            }
        }
        helper({}, 0);
        return combinations;
    }

    /**
     * Run Optimization Process
     */
    async run(dataConfig, baseIndicatorConfig, paramRanges, onProgress) {
        this.isRunning = true;
        this.results = [];
        
        const combinations = this.generateGrid(paramRanges);
        this.totalCombinations = combinations.length;
        this.currentCombination = 0;

        if (this.totalCombinations === 0) {
            this.isRunning = false;
            return [];
        }

        // Fetch historically just ONCE
        if (onProgress) onProgress({ phase: 'fetching_data', progress: 0, msg: 'Downloading Historical Data...' });
        
        await backtester.fetchData(dataConfig, (c, t) => {
             if(onProgress) onProgress({ phase: 'fetching_data', progress: (c/t)*10 });
        });
        
        // Lookback period for indicators (reduced for optimizer/backtest speed)
        const lookbackPeriod = 40; 
        const candleCount = backtester.historicalData?.market1?.length || 0;
        console.log(`[Optimizer] Data Fetch Complete. Candles: ${candleCount}`);
        
        if (candleCount === 0) {
            this.isRunning = false;
            throw new Error("No historical data found for this period. Try a different date range.");
        }

        // CRITICAL: Reset signal engine state and enable backtest mode
        // The optimizer calls runSimulation() directly, which uses backtester's signal engine.
        // Without this, the signal engine's cooldown (Date.now() based) blocks rapid signals.
        backtester.signalEngine.reset();
        backtester.signalEngine.backtestMode = true;

        for (const combo of combinations) {
            if (!this.isRunning) break;

            // Deep clone config
            const testConfig = JSON.parse(JSON.stringify(baseIndicatorConfig));
            
            // Apply parameters from this combination
            for (const key of Object.keys(combo)) {
                const parts = key.split('.');
                let obj = testConfig;
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!obj[parts[i]]) obj[parts[i]] = {};
                    obj = obj[parts[i]];
                }
                obj[parts[parts.length - 1]] = combo[key];
            }

            // Ensure at least one indicator is set to 'primary' to generate entry signals
            const hasPrimary = Object.values(testConfig).some(c => c && c.enabled === 'primary');
            if (!hasPrimary) {
                // Default: set slowSupertrend as primary trigger if nothing else is primary
                if (testConfig.slowSupertrend) {
                    testConfig.slowSupertrend.enabled = 'primary';
                } else if (testConfig.ai) {
                    testConfig.ai.enabled = 'primary';
                }
            }

            // CRITICAL: Enable AI backtestMode to skip safety guards (cooldown, session, funding filters)
            // These depend on live API data and Date.now() which are meaningless in simulation
            if (testConfig.ai && testConfig.ai.enabled !== 'off') {
                testConfig.ai.backtestMode = true;
                testConfig.ai.sessionFilter = false;
                testConfig.ai.fundingFilter = false;
                testConfig.ai.liquidationFilter = false;
            }

            // Run Backtester without fetching overhead
            const stats = backtester.runSimulation(testConfig, dataConfig, null);
            
            // LOGGING: Show progress in background console
            if (stats.summary.totalTrades > 0) {
                console.log(`[Optimizer] Test #${this.currentCombination + 1}: ${stats.summary.totalTrades} trades, PnL: ${stats.summary.totalPnLPercent}%`);
            }
            
            // Calculate a composite "Fitness Score"
            const sharpe = parseFloat(stats.advancedMetrics?.sharpeRatio) || 0;
            const returns = parseFloat(stats.summary.totalPnLPercent) || 0;
            const pFactor = parseFloat(stats.summary.profitFactor) || 0;

            if (stats.summary.totalTrades >= 1) { // Require at least 1 trade to show in results
                this.results.push({
                    params: combo,
                    score: (sharpe * 10) + returns + (pFactor * 2),
                    metrics: {
                        winRate: parseFloat(stats.summary.winRate),
                        pnlPercent: parseFloat(stats.summary.totalPnLPercent),
                        drawdown: parseFloat(stats.metrics.maxDrawdown),
                        sharpe,
                        profitFactor: pFactor,
                        trades: stats.summary.totalTrades
                    }
                });
            }

            this.currentCombination++;
            if (onProgress && (this.currentCombination % 5 === 0 || this.currentCombination === this.totalCombinations)) {
                onProgress({
                    phase: 'optimizing',
                    progress: 10 + ((this.currentCombination / this.totalCombinations) * 90),
                    current: this.currentCombination,
                    total: this.totalCombinations,
                    bestSoFar: this.getBest()
                });
            }

            // Small yield to let UI breathe and prevent freezing
            await new Promise(r => setTimeout(r, 1));
        }

        this.isRunning = false;
        backtester.signalEngine.backtestMode = false;
        
        // Sort by score
        this.results.sort((a, b) => b.score - a.score);
        return this.results;
    }

    getBest() {
        if (this.results.length === 0) return null;
        let best = this.results[0];
        for (const r of this.results) {
            if (r.score > best.score) best = r;
        }
        return best;
    }

    stop() {
        this.isRunning = false;
    }
}

const optimizerEngine = new OptimizerEngine();
export default optimizerEngine;
export { OptimizerEngine };
