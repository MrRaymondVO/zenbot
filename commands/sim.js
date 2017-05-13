var tb = require('timebucket')
  , minimist = require('minimist')
  , n = require('numbro')
  , fs = require('fs')
  , path = require('path')
  , moment = require('moment')

module.exports = function container (get, set, clear) {
  var c = get('conf')
  return function (program) {
    program
      .command('sim [selector]')
      .allowUnknownOption()
      .description('run a simulation on backfilled data')
      .option('--strategy <name>', 'strategy to use', String, c.strategy)
      .option('--start <timestamp>', 'start at timestamp')
      .option('--end <timestamp>', 'end at timestamp')
      .option('--days <days>', 'set duration by day count')
      .option('--currency_capital <amount>', 'amount of start capital in currency', Number, c.currency_capital)
      .option('--asset_capital <amount>', 'amount of start capital in asset', Number, c.asset_capital)
      .option('--buy_pct <pct>', 'buy with this % of currency balance', Number, c.buy_pct)
      .option('--sell_pct <pct>', 'sell with this % of asset balance', Number, c.sell_pct)
      .option('--markup_pct <pct>', '% to mark up or down ask/bid price', Number, c.markup_pct)
      .option('--order_adjust_time <ms>', 'adjust bid/ask on this interval to keep orders competitive', Number, c.order_adjust_time)
      .option('--sell_stop_pct <pct>', 'sell if price drops below this % of bought price', Number, c.sell_stop_pct)
      .option('--buy_stop_pct <pct>', 'buy if price surges above this % of sold price', Number, c.buy_stop_pct)
      .option('--profit_stop_enable_pct <pct>', 'enable trailing sell stop when reaching this % profit', Number, c.profit_stop_enable_pct)
      .option('--profit_stop_pct <pct>', 'maintain a trailing stop this % below the high-water mark of profit', Number, c.profit_stop_pct)
      .option('--max_sell_loss_pct <pct>', 'avoid selling at a loss pct under this float', c.max_sell_loss_pct)
      .option('--max_slippage_pct <pct>', 'avoid selling at a slippage pct above this float', c.max_slippage_pct)
      .option('--symmetrical', 'reverse time at the end of the graph, normalizing buy/hold to 0', Boolean, c.symmetrical)
      .option('--rsi_periods <periods>', 'number of periods to calculate RSI at', Number, c.rsi_periods)
      .option('--enable_stats', 'enable printing order stats')
      .action(function (selector, cmd) {
        var s = {options: minimist(process.argv)}
        var so = s.options
        delete so._
        Object.keys(c).forEach(function (k) {
          if (typeof cmd[k] !== 'undefined') {
            so[k] = cmd[k]
          }
        })
        if (so.start) {
          so.start = moment(so.start).valueOf()
          if (so.days) {
            so.end = tb(so.start).resize('1d').add(so.days).toMilliseconds()
          }
        }
        if (so.end) {
          so.end = moment(so.end).valueOf()
          if (so.days) {
            so.start = tb(so.end).resize('1d').subtract(so.days).toMilliseconds()
          }
        }
        if (!so.start && so.days) {
          var d = tb('1d')
          if (!so.end) {
            so.end = d.toMilliseconds()
          }
          if (so.days) {
            so.start = d.subtract(so.days).toMilliseconds()
          }
        }
        so.stats = !!cmd.enable_stats
        so.selector = get('lib.normalize-selector')(selector || c.selector)
        so.mode = 'sim'
        var engine = get('lib.engine')(s)
        if (!so.min_periods) so.min_periods = 1
        var cursor, reversing, reverse_point
        var query_start = so.start ? tb(so.start).resize(so.period).subtract(so.min_periods + 2).toMilliseconds() : null

        function exitSim () {
          console.log(so)
          if (!s.period) {
            console.error('no trades found! try running `zenbot backfill ' + so.selector + '` first')
            process.exit(1)
          }
          s.balance.currency += s.period.close * s.balance.asset
          s.balance.asset = 0
          s.lookback.unshift(s.period)
          var profit = (s.balance.currency - s.start_capital) / s.start_capital
          console.log('end balance', n(s.balance.currency).format('0.00').yellow + ' (' + n(profit).format('0.00%') + ')')
          var buy_hold = s.period.close * (s.start_capital / s.start_price)
          var buy_hold_profit = (buy_hold - s.start_capital) / s.start_capital
          console.log('buy hold', n(buy_hold).format('0.00').yellow + ' (' + n(buy_hold_profit).format('0.00%') + ')')
          console.log('vs. buy hold', n((s.balance.currency - buy_hold) / buy_hold).format('0.00%').yellow)
          console.log(s.my_trades.length + ' trades over ' + s.day_count + ' days (avg ' + n(s.my_trades.length / s.day_count).format('0.00') + ' trades/day)')
          var data = s.lookback.map(function (period) {
            return {
              time: period.time,
              open: period.open,
              high: period.high,
              low: period.low,
              close: period.close,
              volume: period.volume
            }
          })
          var code = 'var data = ' + JSON.stringify(data) + ';\n'
          code += 'var trades = ' + JSON.stringify(s.my_trades) + ';\n'
          var tpl = fs.readFileSync(path.resolve(__dirname, '..', 'templates', 'sim_result.html.tpl'), {encoding: 'utf8'})
          var out = tpl.replace('{{code}}', code).replace('{{trend_ema_period}}', so.trend_ema || 36)
          var out_target = 'sim_result.html'
          fs.writeFileSync(out_target, out)
          console.log('wrote', out_target)
          process.exit(0)
        }

        function getNext () {
          var opts = {
            query: {
              selector: so.selector,
              time: {$lte: so.end}
            },
            sort: {time: 1},
            limit: 1000
          }
          if (cursor) {
            if (reversing) {
              opts.query.time = {}
              opts.query.time['$lt'] = cursor
              if (query_start) {
                opts.query.time['$gte'] = query_start
              }
              opts.sort = {time: -1}
            }
            else {
              opts.query.time['$gt'] = cursor
            }
          }
          else if (query_start) {
            opts.query.time['$gte'] = query_start
          }
          get('db.trades').select(opts, function (err, trades) {
            if (err) throw err
            if (!trades.length) {
              if (so.symmetrical && !reversing) {
                reversing = true
                reverse_point = cursor
                return getNext()
              }
              engine.exit(exitSim)
            }
            if (so.symmetrical && reversing) {
              trades.forEach(function (trade) {
                trade.orig_time = trade.time
                trade.time = reverse_point + (reverse_point - trade.time)
              })
            }
            engine.update(trades, function (err) {
              if (err) throw err
              cursor = trades[trades.length - 1].time
              setImmediate(getNext)
            })
          })
        }
        getNext()
      })
  }
}