import express from 'express';
import dotenv from 'dotenv';
import amazonPaapi from 'amazon-paapi';
import cors from 'cors';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const DEAL_REFRESH_MS = Number(process.env.DEAL_REFRESH_MS || 5 * 60 * 1000);
const DEFAULT_DEAL_FEED_PATH = path.resolve(__dirname, '..', 'RSForwarder', 'exports', 'ngk_amazon_deals.json');
const DEAL_FEED_PATH = resolveLocalPath(process.env.DEAL_FEED_PATH, DEFAULT_DEAL_FEED_PATH);

let cachedDeals = [];
let lastDealFetch = null;
let lastDealError = null;
let refreshInFlight = null;

const commonParams = {
  AccessKey: process.env.ACCESS_KEY,
  SecretKey: process.env.SECRET_KEY,
  PartnerTag: process.env.PARTNER_TAG,
  PartnerType: 'Associates',
  Marketplace: 'www.amazon.com'
};

app.use(cors());
app.use(express.static(__dirname));

app.get('/api/asin/:asin', async (req, res) => {
  const { asin } = req.params;

  try {
    const item = await getAmazonItem(asin);

    res.json({
      title: item.title,
      image: item.image,
      price: item.price,
      link: buildAmazonAffiliateLink(asin)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch data for ASIN.' });
  }
});

app.get('/api/deals', async (_req, res) => {
  if (shouldRefreshDeals()) {
    refreshDeals().catch((err) => console.error('Deal refresh failed:', err));
  }

  res.json({
    updatedAt: lastDealFetch,
    error: lastDealError,
    deals: cachedDeals
  });
});

app.get('/api/deals/refresh', async (req, res) => {
  if (process.env.ADMIN_REFRESH_KEY && req.query.key !== process.env.ADMIN_REFRESH_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    await refreshDeals();
    res.json({ updatedAt: lastDealFetch, deals: cachedDeals.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`NGKFlip running at http://localhost:${PORT}`);
  refreshDeals().catch((err) => console.error('Initial deal refresh failed:', err.message));
  setInterval(() => {
    refreshDeals().catch((err) => console.error('Scheduled deal refresh failed:', err.message));
  }, DEAL_REFRESH_MS);
});

function shouldRefreshDeals() {
  if (refreshInFlight) return false;
  if (!lastDealFetch) return true;

  return Date.now() - new Date(lastDealFetch).getTime() > DEAL_REFRESH_MS;
}

function resolveLocalPath(configuredPath, fallbackPath) {
  const value = String(configuredPath || '').trim();
  if (!value) return fallbackPath;
  return path.isAbsolute(value) ? value : path.resolve(__dirname, value);
}

async function refreshDeals() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = loadConfiguredDeals()
    .then((deals) => {
      cachedDeals = deals;
      lastDealFetch = new Date().toISOString();
      lastDealError = null;
      return deals;
    })
    .catch((err) => {
      lastDealError = err.message;
      throw err;
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

async function loadConfiguredDeals() {
  try {
    return await loadRsForwarderDeals();
  } catch (err) {
    if (!hasDiscordConfig()) {
      throw err;
    }

    console.warn(`RSForwarder deal feed unavailable, falling back to Discord: ${err.message}`);
    return loadDiscordDeals();
  }
}

async function loadRsForwarderDeals() {
  const raw = await fs.readFile(DEAL_FEED_PATH, 'utf8');
  const payload = JSON.parse(raw);
  const rows = Array.isArray(payload) ? payload : payload.deals;

  if (!Array.isArray(rows)) {
    throw new Error(`Deal feed does not contain a deals array: ${DEAL_FEED_PATH}`);
  }

  return rows
    .map((deal, index) => buildDealFromExport(deal, index, payload))
    .filter(Boolean)
    .slice(0, Number(process.env.MAX_DEALS || 24));
}

function buildDealFromExport(deal, index, payload) {
  const title = cleanDealTitle(deal.title);
  const sourceUrl = deal.monitor_url || deal.store_url || deal.url || '';
  const affiliateUrl = deal.affiliate_url || deal.url || sourceUrl;
  const asin = extractAsin(`${deal.sku || ''} ${sourceUrl} ${affiliateUrl}`);

  if (!title || !affiliateUrl) {
    return null;
  }

  return {
    id: `${String(deal.store || 'amazon').toLowerCase()}-${deal.sku || normalizeDealUrl(affiliateUrl) || index}`,
    asin,
    merchant: 'Amazon',
    title,
    image: '',
    price: '',
    beforePrice: '',
    discount: '',
    sourceUrl,
    affiliateUrl,
    postedAt: payload.exported_at || payload.updatedAt || null,
    channelId: '',
    sourceName: 'RSForwarder RS-FS Live List',
    note: buildExportDealNote(deal)
  };
}

function buildExportDealNote(deal) {
  const parts = [];

  if (deal.category) {
    parts.push(`Category: ${deal.category}`);
  }

  if (deal.comps) {
    parts.push(`Comps: ${deal.comps}`);
  }

  return trimText(parts.join(' | '), 220);
}

async function loadDiscordDeals() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelIds = getDealChannelIds();

  if (!token || channelIds.length === 0) {
    return [];
  }

  const uniqueDeals = new Map();
  const channelFetches = channelIds.map((channelId) => fetchDiscordMessages(token, channelId));
  const channelResults = await Promise.all(channelFetches);

  for (const { channelId, messages } of channelResults) {
    for (const message of messages) {
      const deals = await buildDealsFromMessage(message, channelId);

      for (const deal of deals) {
        if (!uniqueDeals.has(deal.id)) {
          uniqueDeals.set(deal.id, deal);
        }
      }
    }
  }

  return [...uniqueDeals.values()]
    .sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0))
    .slice(0, Number(process.env.MAX_DEALS || 24));
}

function getDealChannelIds() {
  return String(process.env.DISCORD_CHANNEL_IDS || process.env.DISCORD_CHANNEL_ID || '')
    .split(',')
    .map((channelId) => channelId.trim())
    .filter(Boolean);
}

function hasDiscordConfig() {
  return Boolean(process.env.DISCORD_BOT_TOKEN && getDealChannelIds().length > 0);
}

async function fetchDiscordMessages(token, channelId) {
  const limit = Number(process.env.DISCORD_MESSAGE_LIMIT || 50);
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`, {
    headers: {
      Authorization: `Bot ${token}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord channel ${channelId} returned ${response.status}: ${text}`);
  }

  return {
    channelId,
    messages: await response.json()
  };
}

async function buildDealsFromMessage(message, channelId) {
  const embeds = message.embeds?.length ? message.embeds : [null];
  const deals = [];

  for (let index = 0; index < embeds.length; index += 1) {
    const embed = embeds[index];
    const deal = await buildDealFromEmbed(message, embed, channelId, index);

    if (deal) {
      deals.push(deal);
    }
  }

  return deals;
}

async function buildDealFromEmbed(message, embed, channelId, index) {
  const fieldMap = getEmbedFieldMap(embed);
  const text = getSearchableMessageText(message, embed, fieldMap);
  const urls = extractUrls(text);
  const rawUrl = embed?.url || urls.find(isLikelyProductUrl) || urls[0] || '';
  const expandedUrl = rawUrl.includes('amzn.to') ? await expandShortUrl(rawUrl) : rawUrl;
  const asin = extractAsin(`${text} ${expandedUrl}`);

  if (!embed && !rawUrl && !asin) {
    return null;
  }

  const title = cleanDealTitle(
    embed?.title ||
    fieldMap.title ||
    fieldMap.product ||
    message.content ||
    (asin ? `Amazon deal ${asin}` : 'Deal from RSForwarder')
  );
  const image = embed?.image?.url || embed?.thumbnail?.url || message.attachments?.[0]?.url || '';
  const currentPrice = fieldMap.currentPrice || fieldMap.price || extractPrice(text);
  const beforePrice = fieldMap.before || fieldMap.listPrice || fieldMap.was || '';
  const discount = fieldMap.discount || '';
  const merchant = detectMerchant(expandedUrl || rawUrl || text);
  const id = asin || normalizeDealUrl(expandedUrl || rawUrl) || `${message.id}-${index}`;

  let amazonItem = null;
  if (asin && merchant === 'Amazon' && hasAmazonCredentials()) {
    amazonItem = await getAmazonItem(asin).catch(() => null);
  }

  return {
    id,
    asin,
    merchant,
    title: amazonItem?.title || title,
    image: amazonItem?.image || image,
    price: amazonItem?.price || currentPrice,
    beforePrice,
    discount,
    sourceUrl: expandedUrl || rawUrl,
    affiliateUrl: buildDealUrl({ asin, merchant, url: expandedUrl || rawUrl }),
    postedAt: message.timestamp,
    channelId,
    sourceName: embed?.footer?.text || message.author?.username || 'RSForwarder',
    note: buildDealNote({ fieldMap, message })
  };
}

function getEmbedFieldMap(embed) {
  const fieldMap = {};

  for (const field of embed?.fields || []) {
    const key = normalizeFieldName(field.name);
    if (key) {
      fieldMap[key] = cleanFieldValue(field.value);
    }
  }

  return fieldMap;
}

function normalizeFieldName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_match, char) => char.toUpperCase())
    .replace(/[^a-z0-9]/g, '');
}

function cleanFieldValue(value) {
  return String(value || '')
    .replace(/\*\*/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSearchableMessageText(message, embed, fieldMap) {
  const fieldText = Object.entries(fieldMap)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' ');

  return [
    message.content,
    embed?.title,
    embed?.description,
    embed?.url,
    fieldText,
    embed?.footer?.text,
    message.attachments?.map((attachment) => attachment.url).join(' ')
  ]
    .filter(Boolean)
    .join(' ');
}

async function getAmazonItem(asin) {
  if (!hasAmazonCredentials()) {
    throw new Error('Amazon API credentials are missing.');
  }

  const data = await amazonPaapi.GetItems(commonParams, {
    ItemIds: [asin],
    Resources: [
      'ItemInfo.Title',
      'Images.Primary.Medium',
      'Offers.Listings.Price'
    ]
  });

  const item = data.ItemsResult.Items[0];

  return {
    title: item.ItemInfo.Title.DisplayValue,
    image: item.Images?.Primary?.Medium?.URL || '',
    price: item.Offers?.Listings?.[0]?.Price?.DisplayAmount || ''
  };
}

function hasAmazonCredentials() {
  return Boolean(process.env.ACCESS_KEY && process.env.SECRET_KEY && process.env.PARTNER_TAG);
}

function buildDealUrl({ asin, merchant, url }) {
  if (merchant === 'Amazon' && asin) {
    return buildAmazonAffiliateLink(asin);
  }

  return url || '#';
}

function buildAmazonAffiliateLink(asin) {
  const tag = process.env.PARTNER_TAG || '';
  const suffix = tag ? `?tag=${encodeURIComponent(tag)}` : '';

  return `https://www.amazon.com/dp/${asin}${suffix}`;
}

function extractUrls(text) {
  return [...String(text || '').matchAll(/https?:\/\/[^\s<>)]+/gi)].map((match) => trimTrailingUrlPunctuation(match[0]));
}

function trimTrailingUrlPunctuation(url) {
  return url.replace(/[.,;:]+$/g, '');
}

function isLikelyProductUrl(url) {
  return /amazon\.com|amzn\.to|walmart\.com|mavely\.app|target\.com|bestbuy\.com/i.test(url);
}

function extractAsin(text) {
  const patterns = [
    /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i,
    /(?:asin=|ASIN[:\s]+)([A-Z0-9]{10})/i,
    /\b(B0[A-Z0-9]{8})\b/i
  ];

  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match) return match[1].toUpperCase();
  }

  return '';
}

async function expandShortUrl(url) {
  if (!url) return '';

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow'
    });

    return response.url || url;
  } catch {
    return url;
  }
}

function extractPrice(text) {
  return String(text || '').match(/\$\s?\d+(?:\.\d{2})?/)?.[0]?.replace(/\s+/g, '') || '';
}

function detectMerchant(text) {
  const value = String(text || '').toLowerCase();

  if (value.includes('amazon.com') || value.includes('amzn.to')) return 'Amazon';
  if (value.includes('walmart.com')) return 'Walmart';
  if (value.includes('mavely.app')) return 'Mavely';
  if (value.includes('target.com')) return 'Target';
  if (value.includes('bestbuy.com')) return 'Best Buy';

  return 'Deal';
}

function normalizeDealUrl(url) {
  if (!url) return '';

  try {
    const parsed = new URL(url);
    parsed.hash = '';

    return parsed.toString();
  } catch {
    return url;
  }
}

function buildDealNote({ fieldMap, message }) {
  const parts = [];

  if (fieldMap.avgSoldPrice) {
    parts.push(`Avg sold price: ${fieldMap.avgSoldPrice}`);
  }

  if (fieldMap.comps || fieldMap.ebayComps) {
    parts.push(`Comps: ${fieldMap.comps || fieldMap.ebayComps}`);
  }

  if (message.content && !message.content.startsWith('http')) {
    parts.push(message.content);
  }

  return trimText(parts.join(' | '), 220);
}

function cleanDealTitle(text) {
  return trimText(String(text || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim(), 140) || 'Deal from RSForwarder';
}

function trimText(text, maxLength) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();

  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}...` : clean;
}
