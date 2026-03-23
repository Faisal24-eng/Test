// ================================================
// NEXUS TRADING TERMINAL - BACKTESTER
// Historical backtesting engine
// ================================================

import { fetchHistoricalOHLCV, toCSV, getIntervalMs } from './binance-api.js';
import { SignalEngine } from './signal-engine.js';

/**
 * Backtester - runs strategies on historical data
 */
class Backtester {
    constructor() {
        this.isRunning = false;
        this.progress = 0;
        this.results = null;
        this.historicalData = [];
        this.signalEngine = new SignalEngine();
    }

    /**
     * Run backtest
     * @param {object} config - Backtest configuration
     * @param {object} indicatorConfig - Indicator settings
     * @param {function} onProgress - Progress callback
     * @returns {Promise<object>} - Backtest results
     */
    async run(config, indicatorConfig, onProgress = null) {
        this.isRunning = true;
        this.progress = 0;
        this.results = null;
        this.config = config; // Store config for order amount

        // Reset signal engine state to prevent leakage between runs
        this.signalEngine.reset();
        this.signalEngine.backtestMode = true;

        try {
            // Fetch historical data
            await this.fetchData(config, (current, total) => {
                this.progress = (current / total) * 50; // 0-50% for fetching
                if (onProgress) onProgress({ phase: 'fetching', progress: this.progress, current, total });
            });

            // Run simulation
            const simResults = this.runSimulation(indicatorConfig, config, (processed, total) => {
                this.progress = 50 + (processed / total) * 50; // 50-100% for simulation
                if (onProgress) onProgress({ phase: 'simulating', progress: this.progress, processed, total });
            });

            this.results = simResults;
            this.isRunning = false;

            return this.results;
        } catch (error) {
            this.isRunning = false;
            this.signalEngine.backtestMode = false;
            throw error;
        } finally {
            this.signalEngine.backtestMode = false;
        }
    }

    /**
     * Fetch historical data for both markets
     */
    async fetchData(config, onProgress) {
        const startTime = new Date(config.startDate).getTime();
        const endTime = new Date(config.endDate).getTime();

        // Fetch Market 1 data
        const m1 = config.market1 || { symbol: 'BTCUSDT', interval: '1m', marketType: 'perpetual' };
        this.historicalData = {
            market1: await fetchHistoricalOHLCV(
                m1.symbol,
                m1.interval,
                startTime,
                endTime,
                m1.marketType || 'perpetual',
                (current, total) => {
                    if (onProgress) onProgress(current / 2, total);
                }
            )
        };

        // Fetch Market 2 data (if different symbol or interval)
        const m2 = config.market2 || { symbol: 'SOLUSDT', interval: '1m', marketType: 'perpetual' };
        if (m2.symbol !== m1.symbol || m2.interval !== m1.interval) {
            this.historicalData.market2 = await fetchHistoricalOHLCV(
                m2.symbol,
                m2.interval,
                startTime,
                endTime,
                m2.marketType || 'perpetual',
                (current, total) => {
                    if (onProgress) onProgress(total / 2 + current / 2, total);
                }
            );
        } else {
            // Same symbol and interval - reuse market 1 data
            this.historicalData.market2 = this.historicalData.market1;
        }

        // Debug: Log fetched data info
        console.log('[Backtester] Data fetched:', {
            market1: `${m1.symbol} @ ${m1.interval} - ${this.historicalData.market1?.length || 0} candles`,
            market2: `${m2.symbol} @ ${m2.interval} - ${this.historicalData.market2?.length || 0} candles`,
            sameData: this.historicalData.market1 === this.historicalData.market2
        });

        return this.historicalData;
    }

    /**
     * Run simulation on historical data
     */
    runSimulation(indicatorConfig, backtestConfig, onProgress) {
        const trades = [];
        let currentPosition = null;

        // Order amount in USDT (from config or default $100)
        const orderAmountUSDT = backtestConfig.orderAmountUSDT || 100;
        let balance = backtestConfig.initialBalance || 10000; // Starting balance in USDT
        const initialBalance = balance;

        // Trading fee (default 0.04% per trade - typical futures maker fee)
        const feePercent = backtestConfig.feePercent ?? 0.04;
        let totalFees = 0;

        const lookbackPeriod = 200; // Minimum candles for indicators
        const market1Data = this.historicalData.market1;
        const market2Data = this.historicalData.market2;

        // Select which market to use for trade execution (entry/exit prices)
        const executionMarket = backtestConfig.executionMarket || 1;
        const executionData = executionMarket === 2 ? market2Data : market1Data;

        console.log(`[Backtester] Execution market: ${executionMarket}, using ${executionMarket === 2 ? 'market2' : 'market1'} prices`);

        // Store previous signal for proper execution timing
        let previousSignals = null;

        // Prepare indicator config once (order book disabled for backtesting)
        const indicatorBacktestConfig = this.prepareBacktestConfig(indicatorConfig);

        const totalIterations = executionData.length - lookbackPeriod;
        let lastProgressUpdate = 0;

        for (let i = lookbackPeriod; i < executionData.length; i++) {
            // Check if stopped
            if (!this.isRunning) {
                break;
            }

            // Update progress every 100 candles or 1%
            const currentIteration = i - lookbackPeriod;
            if (currentIteration - lastProgressUpdate >= 100 || currentIteration === totalIterations - 1) {
                if (onProgress) {
                    onProgress(currentIteration, totalIterations);
                }
                lastProgressUpdate = currentIteration;
            }

            const currentCandle = executionData[i];
            const previousCandle = executionData[i - 1];

            // === EXECUTION PHASE: Execute signals from PREVIOUS candle at CURRENT open ===
            // This prevents lookahead bias - we decide based on past data, execute at new candle open
            if (previousSignals) {
                // Process close signals first
                if (previousSignals.closePosition && currentPosition) {
                    // Close position at current candle open (next bar execution)
                    const exitPrice = currentCandle.open;
                    const pnl = this.calculatePnL(currentPosition, exitPrice, feePercent);
                    totalFees += (currentPosition.sizeUSDT * feePercent / 100);

                    trades.push({
                        ...currentPosition,
                        exitTime: currentCandle.timestamp,
                        exitPrice,
                        pnl,
                        exitReason: 'protection'
                    });

                    balance += pnl;
                    currentPosition = null;
                }

                // Process entry/flip signals
                if (previousSignals.primary && previousSignals.secondaryPass) {
                    if (!currentPosition) {
                        // Calculate position size in asset units based on USDT amount
                        const positionSizeUSDT = Math.min(orderAmountUSDT, balance);
                        const entryPrice = currentCandle.open;
                        const fee = positionSizeUSDT * feePercent / 100;
                        const positionSizeUnits = (positionSizeUSDT - fee) / entryPrice;
                        totalFees += fee;

                        // Open new position at current candle open
                        currentPosition = {
                            type: previousSignals.primary,
                            entryTime: currentCandle.timestamp,
                            entryPrice: entryPrice,
                            sizeUSDT: positionSizeUSDT,
                            sizeUnits: positionSizeUnits
                        };
                    } else if (currentPosition.type !== previousSignals.primary) {
                        // Flip position - close current at open, open opposite at same open
                        const exitPrice = currentCandle.open;
                        const pnl = this.calculatePnL(currentPosition, exitPrice, feePercent);
                        totalFees += (currentPosition.sizeUSDT * feePercent / 100);

                        trades.push({
                            ...currentPosition,
                            exitTime: currentCandle.timestamp,
                            exitPrice,
                            pnl,
                            exitReason: 'flip'
                        });

                        balance += pnl;

                        // Calculate position size for new position
                        const positionSizeUSDT = Math.min(orderAmountUSDT, balance);
                        const fee = positionSizeUSDT * feePercent / 100;
                        const positionSizeUnits = (positionSizeUSDT - fee) / exitPrice;
                        totalFees += fee;

                        // Open opposite
                        currentPosition = {
                            type: previousSignals.primary,
                            entryTime: currentCandle.timestamp,
                            entryPrice: exitPrice,
                            sizeUSDT: positionSizeUSDT,
                            sizeUnits: positionSizeUnits
                        };
                    }
                }
            }

            // === SIGNAL GENERATION PHASE: Calculate signals using data UP TO previous candle ===
            // We use data ending at previousCandle to generate signals for next bar execution
            const dataWindow1 = market1Data.slice(0, i); // Excludes current candle (up to previous)
            const dataWindow2 = market2Data.slice(0, Math.min(i, market2Data.length));

            const marketData = {
                ohlcv: {
                    market1: dataWindow1,
                    market2: dataWindow2
                },
                orderbook: null, // No historical order book
                currentPrice: previousCandle.close
            };

            // Generate signals based on data up to previous candle
            previousSignals = this.signalEngine.processSignals(marketData, indicatorBacktestConfig, currentPosition);
        }

        // Close any remaining position at last candle close
        if (currentPosition) {
            const lastCandle = executionData[executionData.length - 1];
            const exitPrice = lastCandle.close;
            const pnl = this.calculatePnL(currentPosition, exitPrice, feePercent);
            totalFees += (currentPosition.sizeUSDT * feePercent / 100);

            trades.push({
                ...currentPosition,
                exitTime: lastCandle.timestamp,
                exitPrice,
                pnl,
                exitReason: 'end'
            });

            balance += pnl;
        }

        // Calculate statistics
        return this.calculateStatistics(trades, initialBalance, balance, totalFees, feePercent);
    }

    /**
     * Prepare config for backtesting (disable order book)
     */
    prepareBacktestConfig(config) {
        const backtestConfig = JSON.parse(JSON.stringify(config));

        // Disable order book indicator (no historical data)
        if (backtestConfig.orderBook) {
            backtestConfig.orderBook.enabled = 'off';
        }

        return backtestConfig;
    }

    /**
     * Calculate PnL for a trade in USDT (after exit fee)
     */
    calculatePnL(position, exitPrice, feePercent = 0) {
        const entryPrice = position.entryPrice;
        const sizeUnits = position.sizeUnits || (position.sizeUSDT / entryPrice);

        let pnl;
        if (position.type === 'long') {
            // Long: profit when price goes up
            pnl = (exitPrice - entryPrice) * sizeUnits;
        } else {
            // Short: profit when price goes down
            pnl = (entryPrice - exitPrice) * sizeUnits;
        }

        // Deduct exit fee
        const exitFee = (exitPrice * sizeUnits) * feePercent / 100;
        pnl -= exitFee;

        return pnl; // PnL in USDT after fees
    }

    /**
     * Calculate backtest statistics with professional metrics
     */
    calculateStatistics(trades, initialBalance, finalBalance, totalFees = 0, feePercent = 0) {
        const totalTrades = trades.length;
        const winningTrades = trades.filter(t => t.pnl > 0);
        const losingTrades = trades.filter(t => t.pnl <= 0);

        const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;
        const totalPnL = finalBalance - initialBalance;
        const totalPnLPercent = (totalPnL / initialBalance) * 100;

        // Average win/loss
        const avgWin = winningTrades.length > 0
            ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length
            : 0;
        const avgLoss = losingTrades.length > 0
            ? Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length)
            : 0;

        // Profit factor
        const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
        const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

        // Max drawdown
        let peak = initialBalance;
        let maxDrawdown = 0;
        let maxDrawdownDollar = 0;
        let runningBalance = initialBalance;

        for (const trade of trades) {
            runningBalance += trade.pnl;
            if (runningBalance > peak) peak = runningBalance;
            const drawdown = ((peak - runningBalance) / peak) * 100;
            const drawdownDollar = peak - runningBalance;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
                maxDrawdownDollar = drawdownDollar;
            }
        }

        // Longest win/lose streak
        let currentStreak = 0;
        let maxWinStreak = 0;
        let maxLoseStreak = 0;
        let streakType = null;

        for (const trade of trades) {
            const isWin = trade.pnl > 0;
            if (streakType === null || streakType === isWin) {
                streakType = isWin;
                currentStreak++;
            } else {
                if (streakType) maxWinStreak = Math.max(maxWinStreak, currentStreak);
                else maxLoseStreak = Math.max(maxLoseStreak, currentStreak);
                streakType = isWin;
                currentStreak = 1;
            }
        }

        // Final streak
        if (streakType !== null) {
            if (streakType) maxWinStreak = Math.max(maxWinStreak, currentStreak);
            else maxLoseStreak = Math.max(maxLoseStreak, currentStreak);
        }

        // Long vs Short stats
        const longTrades = trades.filter(t => t.type === 'long');
        const shortTrades = trades.filter(t => t.type === 'short');

        // ======= NEW PROFESSIONAL METRICS =======

        // Calculate returns per trade (% of position size)
        const returns = trades.map(t => t.pnl / t.sizeUSDT);
        const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;

        // Standard deviation of returns
        const variance = returns.length > 1
            ? returns.map(r => Math.pow(r - avgReturn, 2)).reduce((a, b) => a + b, 0) / (returns.length - 1)
            : 0;
        const stdDev = Math.sqrt(variance);

        // Downside deviation (only negative returns)
        const negativeReturns = returns.filter(r => r < 0);
        const downsideVariance = negativeReturns.length > 1
            ? negativeReturns.map(r => Math.pow(r, 2)).reduce((a, b) => a + b, 0) / (negativeReturns.length - 1)
            : 0;
        const downsideDeviation = Math.sqrt(downsideVariance);

        // Sharpe Ratio (annualized, assuming ~365 trading days for crypto)
        // Sharpe = (avgReturn - riskFreeRate) / stdDev * sqrt(N)
        const riskFreeRate = 0; // Assume 0 for crypto
        const tradesPerYear = 365 * 24; // Rough estimate for 1m candles
        const sharpeRatio = stdDev > 0
            ? ((avgReturn - riskFreeRate) / stdDev) * Math.sqrt(Math.min(totalTrades, tradesPerYear))
            : 0;

        // Sortino Ratio (uses downside deviation instead of stdDev)
        const sortinoRatio = downsideDeviation > 0
            ? ((avgReturn - riskFreeRate) / downsideDeviation) * Math.sqrt(Math.min(totalTrades, tradesPerYear))
            : avgReturn > 0 ? Infinity : 0;

        // Calmar Ratio (Annual Return / Max Drawdown)
        // Calculate holding period in days
        let holdingPeriodDays = 1;
        if (trades.length >= 2) {
            const firstTradeTime = trades[0].entryTime;
            const lastTradeTime = trades[trades.length - 1].exitTime;
            holdingPeriodDays = Math.max(1, (lastTradeTime - firstTradeTime) / (24 * 60 * 60 * 1000));
        }
        const annualizedReturn = (totalPnLPercent / holdingPeriodDays) * 365;
        const calmarRatio = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : annualizedReturn > 0 ? Infinity : 0;

        // Expectancy: (Win% × AvgWin) - (Loss% × AvgLoss)
        const winPercent = totalTrades > 0 ? winningTrades.length / totalTrades : 0;
        const lossPercent = totalTrades > 0 ? losingTrades.length / totalTrades : 0;
        const expectancy = (winPercent * avgWin) - (lossPercent * avgLoss);
        const expectancyPercent = initialBalance > 0 ? (expectancy / (this.config?.orderAmountUSDT || 100)) * 100 : 0;

        // Average trade duration (in minutes)
        let avgTradeDuration = 0;
        let totalDuration = 0;
        for (const trade of trades) {
            if (trade.entryTime && trade.exitTime) {
                totalDuration += trade.exitTime - trade.entryTime;
            }
        }
        if (trades.length > 0) {
            avgTradeDuration = (totalDuration / trades.length) / (60 * 1000); // Convert to minutes
        }

        // Trade frequency (trades per day)
        const tradesPerDay = holdingPeriodDays > 0 ? totalTrades / holdingPeriodDays : 0;

        // Average RR ratio (only for trades with SL/TP)
        const tradesWithRR = trades.filter(t => t.stopLoss && t.entryPrice);
        let avgRR = 0;
        if (tradesWithRR.length > 0) {
            const rrValues = tradesWithRR.map(t => {
                const risk = Math.abs(t.entryPrice - t.stopLoss);
                const reward = t.pnl > 0 ? Math.abs(t.exitPrice - t.entryPrice) : 0;
                return risk > 0 ? reward / risk : 0;
            });
            avgRR = rrValues.reduce((a, b) => a + b, 0) / rrValues.length;
        }

        // Exit reason breakdown
        const exitReasons = {};
        for (const trade of trades) {
            const reason = trade.exitReason || 'unknown';
            exitReasons[reason] = (exitReasons[reason] || 0) + 1;
        }

        return {
            summary: {
                totalTrades,
                winningTrades: winningTrades.length,
                losingTrades: losingTrades.length,
                winRate: winRate.toFixed(2),
                profitFactor: profitFactor === Infinity ? '∞' : profitFactor.toFixed(2),
                totalPnL: totalPnL.toFixed(2),
                totalPnLPercent: totalPnLPercent.toFixed(2),
                initialBalance,
                finalBalance: finalBalance.toFixed(2),
                totalFees: totalFees.toFixed(2),
                feePercent
            },
            metrics: {
                avgWin: avgWin.toFixed(2),
                avgLoss: avgLoss.toFixed(2),
                maxDrawdown: maxDrawdown.toFixed(2),
                maxDrawdownDollar: maxDrawdownDollar.toFixed(2),
                maxWinStreak,
                maxLoseStreak
            },
            // NEW: Professional trading metrics
            advancedMetrics: {
                sharpeRatio: isFinite(sharpeRatio) ? sharpeRatio.toFixed(2) : 'N/A',
                sortinoRatio: sortinoRatio === Infinity ? '∞' : (isFinite(sortinoRatio) ? sortinoRatio.toFixed(2) : 'N/A'),
                calmarRatio: calmarRatio === Infinity ? '∞' : (isFinite(calmarRatio) ? calmarRatio.toFixed(2) : 'N/A'),
                expectancy: expectancy.toFixed(2),
                expectancyPercent: expectancyPercent.toFixed(2),
                avgTradeDuration: avgTradeDuration.toFixed(1) + ' min',
                tradesPerDay: tradesPerDay.toFixed(2),
                avgRR: avgRR.toFixed(2),
                holdingPeriodDays: holdingPeriodDays.toFixed(1)
            },
            breakdown: {
                longTrades: longTrades.length,
                longWins: longTrades.filter(t => t.pnl > 0).length,
                longPnL: longTrades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2),
                shortTrades: shortTrades.length,
                shortWins: shortTrades.filter(t => t.pnl > 0).length,
                shortPnL: shortTrades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2),
                exitReasons
            },
            trades: trades.slice(-50), // Last 50 trades
            dataPoints: this.historicalData.market1?.length || 0
        };
    }


    /**
     * Export results to CSV
     */
    exportToCSV() {
        if (!this.results || !this.results.trades) return '';

        const headers = 'type,entryTime,entryPrice,exitTime,exitPrice,pnl,exitReason\n';
        const rows = this.results.trades.map(t =>
            `${t.type},${new Date(t.entryTime).toISOString()},${t.entryPrice},${new Date(t.exitTime).toISOString()},${t.exitPrice},${t.pnl.toFixed(2)},${t.exitReason}`
        ).join('\n');

        return headers + rows;
    }

    /**
     * Export historical data to CSV
     */
    exportDataToCSV() {
        return toCSV(this.historicalData);
    }

    /**
     * Stop backtest
     */
    stop() {
        this.isRunning = false;
    }
}

// Singleton instance
const backtester = new Backtester();

export default backtester;
export { Backtester };
