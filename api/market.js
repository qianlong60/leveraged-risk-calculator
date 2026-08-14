const SYMBOL_RE = /^[A-Z0-9.^=\-]{1,24}$/;
const NASDAQ_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nasdaq.com',
  'Referer': 'https://www.nasdaq.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36'
};

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function number(value) {
  const n = Number(String(value ?? '').replace(/[$,%\s]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function isoDate(mmddyyyy) {
  const m = String(mmddyyyy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

async function nasdaq(path) {
  const response = await fetch(`https://api.nasdaq.com${path}`, { headers: NASDAQ_HEADERS });
  if (!response.ok) throw new Error(`Nasdaq HTTP ${response.status}`);
  return response.json();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: '只支持 GET 请求' });
  const symbol = String(req.query?.symbol || '').trim().toUpperCase();
  const start = String(req.query?.start || '').trim();
  if (!SYMBOL_RE.test(symbol)) return send(res, 400, { error: '股票代码格式不正确' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(`${start}T00:00:00Z`))) return send(res, 400, { error: '开始日期无效' });

  try {
    let assetClass = null, info = null;
    for (const candidate of ['etf', 'stocks']) {
      const test = await nasdaq(`/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${candidate}`);
      if (test?.data?.primaryData?.lastSalePrice && test?.status?.rCode === 200) {
        assetClass = candidate;
        info = test.data;
        break;
      }
    }
    if (!assetClass) return send(res, 404, { error: `Nasdaq 行情中找不到 ${symbol}，请检查代码或手动更换` });

    const end = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const history = await nasdaq(`/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=${assetClass}&fromdate=${start}&todate=${end}&limit=5000`);
    const rawRows = history?.data?.tradesTable?.rows || [];
    const rows = rawRows.map(row => {
      const close = number(row.close);
      const date = isoDate(row.date);
      return date && close && close > 0 ? { date, close, adjClose: close } : null;
    }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) return send(res, 404, { error: `${symbol} 在所选日期之后没有可用行情` });

    const primary = info.primaryData || {};
    const currentPrice = number(primary.lastSalePrice) || rows[rows.length - 1].close;
    const parsedTime = Date.parse(String(primary.lastTradeTimestamp || '').replace(/ ET$/, ' -0400'));
    const currentTime = Number.isFinite(parsedTime) ? Math.floor(parsedTime / 1000) : Math.floor(Date.now() / 1000);
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return send(res, 200, {
      symbol: info.symbol || symbol,
      name: info.companyName || symbol,
      currency: 'USD',
      exchange: info.exchange || (assetClass === 'etf' ? 'US ETF' : 'US stock'),
      timezone: 'America/New_York',
      marketState: primary.isRealTime ? 'REALTIME' : 'DELAYED',
      currentPrice,
      currentAdjPrice: currentPrice,
      currentTime,
      rows,
      source: primary.isRealTime ? 'Nasdaq real-time market data' : 'Nasdaq market data'
    });
  } catch (error) {
    return send(res, 502, { error: '行情服务暂时不可用，请稍后重试', detail: String(error?.message || error) });
  }
};
