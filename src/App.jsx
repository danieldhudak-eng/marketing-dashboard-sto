import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { RefreshCw, LayoutDashboard, Settings, Grid, Copy, Check, BarChart2, Share, Download, Users, Cloud, CloudOff, TriangleAlert, X } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import * as XLSX from 'xlsx';

const formatNumber = (num) => {
    if (num === null || num === undefined) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return num.toString();
};

const GRAPH = 'https://graph.facebook.com/v25.0';

const EMPTY_KEYS = { token: '', czId: '', skId: '', czPageId: '', skPageId: '', supabaseUrl: '', supabaseAnon: '' };

// Supabase's UI shows several URLs for one project. supabase-js wants the bare
// project origin — given ".../rest/v1/" it would build ".../rest/v1/rest/v1/..."
// and every request 404s. Accept whichever form gets pasted in.
const normalizeSupabaseUrl = (raw) => {
   let url = (raw || '').trim();
   if (!url) return '';
   if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
   url = url.replace(/\/+$/, '');
   url = url.replace(/\/(rest|auth|realtime|storage)\/v1$/i, '');
   return url;
};

const makeSupabaseClient = (url, key) => {
   const base = normalizeSupabaseUrl(url);
   if (!base || !key) return null;
   return createClient(base, key);
};

// --- Local persistence -------------------------------------------------
// Categories/tags are always written to localStorage first, so they survive a
// refresh even when Supabase is not configured or its write is rejected.
// Supabase remains the cross-device store; conflicts resolve last-write-wins
// on the `updatedAt` stamp we control.
const LOCAL_STATE_KEY = 'sto_dashboard_state';
const DEFAULT_CATEGORIES = ['Case Study', 'Reference'];

const readLocalState = () => {
   try {
      const raw = JSON.parse(localStorage.getItem(LOCAL_STATE_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return null;
      return {
         categories: Array.isArray(raw.categories) ? raw.categories : DEFAULT_CATEGORIES,
         tags: raw.tags && typeof raw.tags === 'object' ? raw.tags : {},
         updatedAt: Number(raw.updatedAt) || 0,
      };
   } catch { return null; }
};

const writeLocalState = (categories, tags, updatedAt) => {
   try { localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify({ categories, tags, updatedAt })); }
   catch (e) { console.error('[state] localStorage write failed', e); }
};

// --- Date helpers ------------------------------------------------------
const toISODate = (d) => d.toISOString().split('T')[0];
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return toISODate(d); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

// Meta caps day-period insight requests, so long ranges are requested in slices.
// Slices deliberately overlap by one day at the boundary (Meta's since/until
// edges are inclusive-ish); dedupeDays drops the duplicates afterwards.
const dateChunks = (from, to, size) => {
   const out = [];
   let cursor = from;
   while (daysBetween(cursor, to) > 0) {
      const end = daysBetween(cursor, to) > size ? addDays(cursor, size) : to;
      out.push([cursor, end]);
      cursor = end;
   }
   if (out.length === 0) out.push([from, to]);
   return out;
};

// One row per day/account/platform — otherwise overlapping slices would make
// `gained` count a boundary day twice.
const dedupeDays = (rows) => {
   const byKey = new Map();
   rows.forEach(r => byKey.set(`${r.day}|${r.account}|${r.platform}`, r));
   return [...byKey.values()];
};

// Bucket a YYYY-MM-DD into the selected granularity.
const bucketOf = (iso, granularity) => {
   if (granularity === 'month') return iso.slice(0, 7);
   if (granularity === 'week') {
      const d = new Date(iso + 'T00:00:00Z');
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      d.setUTCDate(d.getUTCDate() - dow);
      return toISODate(d);
   }
   return iso;
};

const bucketLabel = (key, granularity) => {
   if (granularity === 'month') return new Date(key + '-01T00:00:00Z').toLocaleString('default', { month: 'short', year: 'numeric' });
   if (granularity === 'week') return new Date(key + 'T00:00:00Z').toLocaleDateString('default', { day: '2-digit', month: 'short' });
   return new Date(key + 'T00:00:00Z').toLocaleDateString('default', { day: '2-digit', month: 'short' });
};

// Tooltip showing per-platform metric breakdown. Renders inside an element with .platform-hover.
const PlatformTooltip = ({ platforms }) => {
   const order = ['facebook', 'instagram'].filter(p => platforms?.[p]);
   if (order.length === 0) return null;
   const labels = { facebook: 'Facebook', instagram: 'Instagram' };
   const dots = { facebook: 'fb', instagram: 'ig' };
   return (
      <div className="platform-tooltip">
         <div className="platform-tooltip-grid" style={{ gridTemplateColumns: `repeat(${order.length}, 1fr)` }}>
            {order.map(plat => {
               const m = platforms[plat];
               return (
                  <div key={plat} className="platform-block">
                     <h4><span className={`dot ${dots[plat]}`}></span>{labels[plat]}</h4>
                     <div className="row"><span>Spend</span><span>€{m.spend.toFixed(2)}</span></div>
                     <div className="row"><span>Impr</span><span>{m.impressions.toLocaleString()}</span></div>
                     <div className="row"><span>Reach</span><span>{m.reach.toLocaleString()}</span></div>
                     <div className="row"><span>Engag</span><span>{m.engagements.toLocaleString()}</span></div>
                     <div className="row"><span>Clicks</span><span>{m.clicks.toLocaleString()}</span></div>
                     <div className="row"><span>Plays</span><span>{m.thruPlays.toLocaleString()}</span></div>
                     <div className="row"><span>Foll</span><span>{m.followers.toLocaleString()}</span></div>
                  </div>
               );
            })}
         </div>
      </div>
   );
};

// Per-post platform badge(s). Shows one badge per platform the ad actually delivered on.
const PlatformBadges = ({ networks, variant = 'card' }) => {
   const list = networks && networks.length > 0 ? networks : [];
   const labelMap = { facebook: 'Facebook', instagram: 'Instagram' };
   const shortMap = { facebook: 'FB', instagram: 'IG' };
   const cls = { facebook: 'fb', instagram: 'ig' };
   if (variant === 'mini') {
      return (
         <div className="platform-badges-inline">
            {list.map(n => <span key={n} className={`platform-badge-mini ${cls[n]}`}>{shortMap[n]}</span>)}
         </div>
      );
   }
   return (
      <div className="platform-badges">
         {list.map(n => <span key={n} className={`platform-badge ${cls[n]}`}>{labelMap[n]}</span>)}
      </div>
   );
};

// Follower series are keyed "<COUNTRY>_<platform>", e.g. "CZ_instagram".
const FOLLOWER_COLORS = {
   CZ_facebook: '#1877F2', SK_facebook: '#0b4ea2',
   CZ_instagram: '#dc2743', SK_instagram: '#bc1888',
};
const FOLLOWER_LABELS = (key) => {
   const [acc, plat] = key.split('_');
   return `${acc} ${plat === 'facebook' ? 'Facebook' : 'Instagram'}`;
};

// Where categories/tags currently live: browser-only, syncing, synced, or failed.
const SyncBadge = ({ status, error }) => {
   const map = {
      local:  { icon: <CloudOff size={12} />, label: 'Saved locally', bg: '#f1f5f9', fg: '#475569', bd: '#e2e8f0' },
      saving: { icon: <RefreshCw size={12} className="spinner" />, label: 'Syncing…', bg: '#f1f5f9', fg: '#475569', bd: '#e2e8f0' },
      cloud:  { icon: <Cloud size={12} />, label: 'Synced', bg: '#ecfdf5', fg: '#047857', bd: '#a7f3d0' },
      error:  { icon: <TriangleAlert size={12} />, label: 'Sync failed', bg: '#fef2f2', fg: '#b91c1c', bd: '#fecaca' },
   };
   const s = map[status] || map.local;
   return (
      <span title={error || undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', background: s.bg, color: s.fg, border: `1px solid ${s.bd}`, borderRadius: '20px', padding: '3px 10px', fontSize: '11px', fontWeight: 700 }}>
         {s.icon}{s.label}
      </span>
   );
};

// Facebook / Instagram / both — segmented switch used in the header.
const ChannelSwitch = ({ value, onChange, counts }) => {
   const opts = [
      { id: 'all', label: 'All' },
      { id: 'facebook', label: 'Facebook' },
      { id: 'instagram', label: 'Instagram' },
   ];
   return (
      <div className="channel-switch">
         {opts.map(o => (
            <button
               key={o.id}
               type="button"
               className={`channel-switch-btn ${o.id} ${value === o.id ? 'active' : ''}`}
               onClick={() => onChange(o.id)}
            >
               {o.label}
               <span className="channel-count">{counts?.[o.id] ?? 0}</span>
            </button>
         ))}
      </div>
   );
};

const App = () => {
  const [account, setAccount] = useState('cz');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [campaignFilter, setCampaignFilter] = useState('Post'); 
  const [viewMode, setViewMode] = useState('overview');
  
  const [chartType, setChartType] = useState('bar');
  const [selectedMetrics, setSelectedMetrics] = useState(['spend']);
  const [analyticsCategory, setAnalyticsCategory] = useState('All');
  const [channelFilter, setChannelFilter] = useState('all');

  const [posts, setPosts] = useState([]);

  const [showSettings, setShowSettings] = useState(false);
  const [apiKeys, setApiKeys] = useState(EMPTY_KEYS);

  const [supabaseClient, setSupabaseClient] = useState(null);
  const initialLocal = useMemo(() => readLocalState(), []);
  const [categories, setCategories] = useState(() => initialLocal?.categories || DEFAULT_CATEGORIES);
  const [tags, setTags] = useState(() => initialLocal?.tags || {});
  const [syncStatus, setSyncStatus] = useState('local'); // local | saving | cloud | error
  const [syncError, setSyncError] = useState('');
  const [newCatName, setNewCatName] = useState('');
  const [copiedSql, setCopiedSql] = useState(false);

  // Follower tracking
  const [followerSeries, setFollowerSeries] = useState([]); // { day, account, platform, total, gained }
  const [followerNow, setFollowerNow] = useState([]);       // { account, platform, handle, total }
  const [followersLoading, setFollowersLoading] = useState(false);
  const [followerNotes, setFollowerNotes] = useState([]);
  const [followerGranularity, setFollowerGranularity] = useState('day');

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const payload = searchParams.get('payload');
    
    if (payload) {
        try {
            const parsed = JSON.parse(atob(payload));
            if (parsed.apiKeys) setApiKeys(k => ({ ...k, ...parsed.apiKeys }));
            const shareClient = makeSupabaseClient(parsed.apiKeys?.supabaseUrl, parsed.apiKeys?.supabaseAnon);
            if (shareClient) {
               setSupabaseClient(shareClient);
               loadCloudState(shareClient);
            }
            if (parsed.viewMode) setViewMode(parsed.viewMode);
            if (parsed.account) setAccount(parsed.account);
            if (parsed.dateFrom) setDateFrom(parsed.dateFrom);
            if (parsed.dateTo) setDateTo(parsed.dateTo);
            if (parsed.selectedMetrics) setSelectedMetrics(parsed.selectedMetrics);
            if (parsed.chartType) setChartType(parsed.chartType);
            if (parsed.channelFilter) setChannelFilter(parsed.channelFilter);
            return;
        } catch (e) { console.error("Invalid share payload", e); }
    }

    const today = new Date();
    const lastMonth = new Date();
    lastMonth.setDate(today.getDate() - 30);
    setDateTo(today.toISOString().split('T')[0]);
    setDateFrom(lastMonth.toISOString().split('T')[0]);

    const saved = localStorage.getItem('meta_dashboard_keys');
    if (saved) {
      const parsed = JSON.parse(saved);
      setApiKeys(k => ({ ...k, ...parsed }));

      try {
        const client = makeSupabaseClient(parsed.supabaseUrl, parsed.supabaseAnon);
        if (client) { setSupabaseClient(client); loadCloudState(client); }
      } catch (e) {
        console.error('[sync] could not create Supabase client', e);
        setSyncStatus('error'); setSyncError(e.message);
      }
    } else { setShowSettings(true); }
  }, []);

  // Push to Supabase. Local storage has already been written by the caller, so a
  // failure here degrades to "local only" instead of losing the change.
  const pushCloudState = async (client, nextCategories, nextTags, updatedAt) => {
      if (!client) { setSyncStatus('local'); return; }
      setSyncStatus('saving');
      const { error } = await client.from('app_state').upsert({
          id: 1, categories: nextCategories, tags: nextTags, updated_at: new Date(updatedAt).toISOString(),
      });
      if (error) {
          console.error('[sync] Failed to save to Supabase:', error.message, error);
          setSyncStatus('error');
          setSyncError(error.message);
      } else {
          setSyncStatus('cloud'); setSyncError('');
      }
  };

  const loadCloudState = async (client) => {
      const local = readLocalState() || { categories: DEFAULT_CATEGORIES, tags: {}, updatedAt: 0 };
      setSyncStatus('saving');
      const { data, error } = await client.from('app_state').select('categories, tags, updated_at').eq('id', 1).maybeSingle();

      if (error) {
          console.error('[sync] Failed to read Supabase state:', error.message, error);
          setSyncStatus('error'); setSyncError(error.message);
          return;
      }

      const cloudUpdatedAt = data?.updated_at ? Date.parse(data.updated_at) : 0;
      const cloudHasData = !!data && (Array.isArray(data.categories) || data.tags);

      if (cloudHasData && cloudUpdatedAt >= local.updatedAt) {
          const cats = Array.isArray(data.categories) && data.categories.length ? data.categories : DEFAULT_CATEGORIES;
          const tgs = data.tags && typeof data.tags === 'object' ? data.tags : {};
          setCategories(cats); setTags(tgs);
          writeLocalState(cats, tgs, cloudUpdatedAt || Date.now());
          setSyncStatus('cloud'); setSyncError('');
      } else {
          // Local is newer (or the cloud row is empty) — local wins and gets pushed up.
          setCategories(local.categories); setTags(local.tags);
          await pushCloudState(client, local.categories, local.tags, local.updatedAt || Date.now());
      }
  };

  // Single write path for categories + tags: state → localStorage → Supabase.
  const persistState = (nextCategories, nextTags) => {
      const stamp = Date.now();
      setCategories(nextCategories);
      setTags(nextTags);
      writeLocalState(nextCategories, nextTags, stamp);
      pushCloudState(supabaseClient, nextCategories, nextTags, stamp);
  };

  const handleAddCategory = () => {
    if (!newCatName.trim() || categories.includes(newCatName.trim())) return;
    persistState([...categories, newCatName.trim()], tags);
    setNewCatName('');
  };

  const handleRemoveCategory = (cat) => {
    const nextTags = { ...tags };
    Object.keys(nextTags).forEach(k => { if (nextTags[k] === cat) delete nextTags[k]; });
    persistState(categories.filter(c => c !== cat), nextTags);
  };

  const assignTag = (postId, categoryName) => {
    const nextTags = { ...tags, [postId]: categoryName };
    if (!categoryName) delete nextTags[postId];
    persistState(categories, nextTags);
  };

  useEffect(() => {
    if (dateFrom && dateTo && apiKeys.token) fetchData();
  }, [dateFrom, dateTo, account, apiKeys.token]);

  // Close without applying: drop any in-progress edits and fall back to the
  // last saved credentials. Categories are saved on change, so they are unaffected.
  const closeSettings = () => {
    try {
      const saved = JSON.parse(localStorage.getItem('meta_dashboard_keys') || 'null');
      setApiKeys({ ...EMPTY_KEYS, ...(saved || {}) });
    } catch (e) { console.error('[settings] could not restore saved keys', e); }
    setShowSettings(false);
  };

  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e) => { if (e.key === 'Escape') closeSettings(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSettings]);

  const saveSettings = () => {
    // Store the normalized URL so the field self-corrects on the next open.
    const nextKeys = { ...apiKeys, supabaseUrl: normalizeSupabaseUrl(apiKeys.supabaseUrl) };
    setApiKeys(nextKeys);
    localStorage.setItem('meta_dashboard_keys', JSON.stringify(nextKeys));
    setShowSettings(false);
    try {
      const client = makeSupabaseClient(nextKeys.supabaseUrl, nextKeys.supabaseAnon);
      if (client) { setSupabaseClient(client); loadCloudState(client); }
      else { setSupabaseClient(null); setSyncStatus('local'); setSyncError(''); }
    } catch (e) {
      console.error('[sync] could not create Supabase client', e);
      setSupabaseClient(null); setSyncStatus('error'); setSyncError(e.message);
    }
    if (nextKeys.token) fetchData();
  };

  const fetchAccountData = async (accountId, API_TOKEN, accountTag) => {
      const baseFields = 'ad_id,ad_name,campaign_name,spend,impressions,reach,inline_link_clicks,actions,video_play_actions';
      const timeRange = JSON.stringify({ since: dateFrom, until: dateTo });

      const [insightsResponse, platformResponse] = await Promise.all([
        axios.get(`https://graph.facebook.com/v25.0/${accountId}/insights`, {
          params: { access_token: API_TOKEN, level: 'ad', time_range: timeRange, limit: 150, fields: baseFields }
        }),
        axios.get(`https://graph.facebook.com/v25.0/${accountId}/insights`, {
          params: { access_token: API_TOKEN, level: 'ad', time_range: timeRange, limit: 500, fields: baseFields, breakdowns: 'publisher_platform' }
        }),
      ]);

      const insightsData = insightsResponse.data.data;
      if (!insightsData || insightsData.length === 0) return { posts: [], kpis: { spend: 0, impressions: 0, reach: 0, thruPlays: 0, engagements: 0, linkClicks: 0, followers: 0 } };

      // Build a per-ad map of platform breakdowns
      const getAct = (actions, type) => { const a = (actions || []).find(x => x.action_type === type); return a ? parseInt(a.value) : 0; };
      const platformByAd = {};
      (platformResponse.data.data || []).forEach(row => {
          const platform = row.publisher_platform;
          if (platform !== 'facebook' && platform !== 'instagram') return;
          if (!platformByAd[row.ad_id]) platformByAd[row.ad_id] = {};
          platformByAd[row.ad_id][platform] = {
              spend: parseFloat(row.spend || 0),
              impressions: parseInt(row.impressions || 0),
              reach: parseInt(row.reach || 0),
              clicks: parseInt(row.inline_link_clicks || 0),
              engagements: getAct(row.actions, 'post_engagement'),
              thruPlays: getAct(row.actions, 'video_view'),
              followers: getAct(row.actions, 'like'),
          };
      });

      const filteredInsights = insightsData.filter(ins => {
        if (!campaignFilter) return true;
        const cName = ins.campaign_name?.toLowerCase() || '';
        return campaignFilter.startsWith('-') ? !cName.includes(campaignFilter.substring(1).trim()) : cName.includes(campaignFilter.toLowerCase().trim());
      });

      if (filteredInsights.length === 0) return { posts: [], kpis: { spend: 0, impressions: 0, reach: 0, thruPlays: 0, engagements: 0, linkClicks: 0, followers: 0 } };

      const adIds = filteredInsights.map(i => i.ad_id).join(',');
      const creativesResponse = await axios.get(`https://graph.facebook.com/v25.0/`, {
        params: {
          access_token: API_TOKEN, ids: adIds,
          fields: 'created_time,creative{image_url,thumbnail_url,body,instagram_permalink_url,source_instagram_media_id,object_story_spec,asset_feed_spec}'
        }
      });

      const creativesData = creativesResponse.data;
      let subKpis = { spend: 0, impressions: 0, reach: 0, thruPlays: 0, engagements: 0, linkClicks: 0, followers: 0 };
      
      const subPosts = filteredInsights.map(ins => {
        const adNode = creativesData[ins.ad_id] || {};
        const creative = adNode.creative || {};
        const getAction = (actions, type) => { const action = (actions || []).find(a => a.action_type === type); return action ? parseInt(action.value) : 0; };

        const spend = parseFloat(ins.spend || 0); const impressions = parseInt(ins.impressions || 0);
        const reach = parseInt(ins.reach || 0); const linkClicks = parseInt(ins.inline_link_clicks || 0);
        const postEngagement = getAction(ins.actions, 'post_engagement'); const thruPlays = getAction(ins.actions, 'video_view');
        const followers = getAction(ins.actions, 'like');

        subKpis.spend += spend; subKpis.impressions += impressions; subKpis.reach += reach;
        subKpis.linkClicks += linkClicks; subKpis.engagements += postEngagement; subKpis.thruPlays += thruPlays; subKpis.followers += followers;

        // Per-platform breakdown
        const adPlatforms = platformByAd[ins.ad_id] || {};
        const platforms = {};
        if (adPlatforms.facebook && adPlatforms.facebook.spend + adPlatforms.facebook.impressions > 0) platforms.facebook = adPlatforms.facebook;
        if (adPlatforms.instagram && adPlatforms.instagram.spend + adPlatforms.instagram.impressions > 0) platforms.instagram = adPlatforms.instagram;
        const networks = Object.keys(platforms);

        const cTime = adNode.created_time ? new Date(adNode.created_time) : new Date(dateFrom);
        const monthKey = `${cTime.getFullYear()}-${String(cTime.getMonth()+1).padStart(2, '0')}`;
        const monthLabel = cTime.toLocaleString('default', { month: 'short', year: 'numeric' });

        let hdImage = creative.image_url;
        if (creative.object_story_spec) {
            const spec = creative.object_story_spec;
            if (spec.video_data?.image_url) hdImage = spec.video_data.image_url;
            else if (spec.photo_data?.url) hdImage = spec.photo_data.url;
            else if (spec.link_data?.child_attachments?.[0]?.image_url) hdImage = spec.link_data.child_attachments[0].image_url;
            else if (!hdImage && spec.link_data?.picture) hdImage = spec.link_data.picture;
        }
        if (!hdImage && creative.asset_feed_spec) {
            const asset = creative.asset_feed_spec;
            if (asset.images?.[0]?.url) hdImage = asset.images[0].url;
            else if (asset.videos?.[0]?.thumbnail_url) hdImage = asset.videos[0].thumbnail_url;
        }
        const bestImageUrl = hdImage || creative.thumbnail_url || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?q=80&w=600&auto=format&fit=crop';

        const fallbackNetwork = (creative.source_instagram_media_id || (ins.campaign_name || '').toLowerCase().includes('instagram')) ? 'ig' : 'fb';
        const finalNetworks = networks.length > 0 ? networks : [fallbackNetwork === 'ig' ? 'instagram' : 'facebook'];

        return {
            id: ins.ad_id, monthKey, monthLabel, accountTag,
            network: networks.length === 1 ? (networks[0] === 'instagram' ? 'ig' : 'fb') : (networks.length === 2 ? 'both' : fallbackNetwork),
            networks: finalNetworks,
            platforms,
            text: creative.body || ins.ad_name,
            imageUrl: bestImageUrl,
            metrics: { spend, impressions, reach, engagements: postEngagement, clicks: linkClicks, thruPlays, followers }
        };
      }).filter(post => post.text);

      return { posts: subPosts, kpis: subKpis };
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const API_TOKEN = apiKeys.token;
      if (!API_TOKEN) { setShowSettings(true); setLoading(false); return; }

      const cId = apiKeys.czId.startsWith('act_') ? apiKeys.czId : 'act_' + apiKeys.czId;
      const sId = apiKeys.skId.startsWith('act_') ? apiKeys.skId : 'act_' + apiKeys.skId;

      let accountsToFetch = [];
      if (account === 'cz') accountsToFetch.push({ id: cId, tag: 'CZ' });
      else if (account === 'sk') accountsToFetch.push({ id: sId, tag: 'SK' });
      else if (account === 'both') {
         if (apiKeys.czId) accountsToFetch.push({ id: cId, tag: 'CZ' });
         if (apiKeys.skId) accountsToFetch.push({ id: sId, tag: 'SK' });
      }

      if (accountsToFetch.length === 0) { setShowSettings(true); setLoading(false); return; }

      const results = await Promise.all(accountsToFetch.map(a => fetchAccountData(a.id, API_TOKEN, a.tag)));
      
      setPosts(results.flatMap(res => res.posts));
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 400) setShowSettings(true);
      alert('API Error: ' + (err.response?.data?.error?.message || err.message));
    } finally { setLoading(false); }
  };

  // ---------------------------------------------------------------------
  // Organic follower tracking (Page Insights + Instagram Insights)
  // ---------------------------------------------------------------------

  // Facebook: page_follows is a running lifetime total sampled daily, so it
  // gives an absolute follower curve. Requested in 90-day slices because Meta
  // rejects wider day-period windows.
  const fetchFacebookFollowers = async (pageId, pageToken, accountTag, notes) => {
     const rows = [];
     try {
        for (const [since, until] of dateChunks(dateFrom, dateTo, 90)) {
           const res = await axios.get(`${GRAPH}/${pageId}/insights`, {
              params: { access_token: pageToken, metric: 'page_follows,page_daily_follows_unique,page_daily_unfollows_unique', period: 'day', since, until },
           });
           const byDay = {};
           (res.data.data || []).forEach(metric => {
              (metric.values || []).forEach(v => {
                 const day = (v.end_time || '').split('T')[0];
                 if (!day) return;
                 byDay[day] = byDay[day] || { day, account: accountTag, platform: 'facebook', total: null, gained: 0, lost: 0 };
                 if (metric.name === 'page_follows') byDay[day].total = Number(v.value) || 0;
                 if (metric.name === 'page_daily_follows_unique') byDay[day].gained = Number(v.value) || 0;
                 if (metric.name === 'page_daily_unfollows_unique') byDay[day].lost = Number(v.value) || 0;
              });
           });
           rows.push(...Object.values(byDay));
        }
     } catch (e) {
        notes.push(`Facebook (${accountTag}): ${e.response?.data?.error?.message || e.message}`);
     }
     return dedupeDays(rows);
  };

  // Instagram: follower_count returns NEW followers per day and only covers the
  // last 30 days. The absolute curve is reconstructed backwards from the current
  // followers_count, so historical totals are an approximation (unfollows are
  // not exposed by the API). Anything older comes from stored snapshots.
  const fetchInstagramFollowers = async (igId, token, accountTag, currentTotal, notes) => {
     const rows = [];
     const today = toISODate(new Date());
     const earliest = addDays(today, -29);
     const since = daysBetween(earliest, dateFrom) > 0 ? dateFrom : earliest;
     const until = daysBetween(dateTo, today) > 0 ? dateTo : today;
     if (daysBetween(since, until) < 0) return rows;

     let daily = [];
     try {
        const res = await axios.get(`${GRAPH}/${igId}/insights`, {
           params: { access_token: token, metric: 'follower_count', period: 'day', since, until },
        });
        daily = ((res.data.data || [])[0]?.values || [])
           .map(v => ({ day: (v.end_time || '').split('T')[0], gained: Number(v.value) || 0 }))
           .filter(v => v.day)
           .sort((a, b) => a.day.localeCompare(b.day));
     } catch (e) {
        notes.push(`Instagram (${accountTag}): ${e.response?.data?.error?.message || e.message}`);
     }

     // Walk backwards from today's known total to derive each day's total.
     let running = currentTotal ?? null;
     for (let i = daily.length - 1; i >= 0; i--) {
        rows.unshift({ day: daily[i].day, account: accountTag, platform: 'instagram', total: running, gained: daily[i].gained, lost: 0 });
        if (running !== null) running -= daily[i].gained;
     }
     return rows;
  };

  const fetchFollowers = async () => {
     const token = apiKeys.token;
     const pages = [];
     if ((account === 'cz' || account === 'both') && apiKeys.czPageId) pages.push({ id: apiKeys.czPageId, tag: 'CZ' });
     if ((account === 'sk' || account === 'both') && apiKeys.skPageId) pages.push({ id: apiKeys.skPageId, tag: 'SK' });

     setFollowersLoading(true);
     const notes = [];
     const rawRows = [];
     const current = [];

     try {
        for (const page of pages) {
           if (!token) break;
           let meta;
           try {
              const res = await axios.get(`${GRAPH}/${page.id}`, {
                 params: { access_token: token, fields: 'name,followers_count,fan_count,access_token,instagram_business_account{id,username,followers_count}' },
              });
              meta = res.data;
           } catch (e) {
              notes.push(`Page ${page.id} (${page.tag}): ${e.response?.data?.error?.message || e.message}`);
              continue;
           }

           // A Page access token is required for Page Insights; fall back to the
           // user token when the field is not returned.
           const pageToken = meta.access_token || token;
           current.push({ account: page.tag, platform: 'facebook', handle: meta.name || page.id, total: Number(meta.followers_count ?? meta.fan_count ?? 0) });
           rawRows.push(...await fetchFacebookFollowers(page.id, pageToken, page.tag, notes));

           const ig = meta.instagram_business_account;
           if (ig?.id) {
              current.push({ account: page.tag, platform: 'instagram', handle: ig.username ? '@' + ig.username : ig.id, total: Number(ig.followers_count ?? 0) });
              rawRows.push(...await fetchInstagramFollowers(ig.id, pageToken, page.tag, Number(ig.followers_count ?? 0), notes));
           } else {
              notes.push(`No Instagram business account linked to page ${meta.name || page.id} (${page.tag}).`);
           }
        }

        if (pages.length === 0) notes.push('Add a Facebook Page ID in Settings to track followers.');

        const apiRows = dedupeDays(rawRows);

        // Persist today's readings so history outlives the API windows.
        if (supabaseClient && apiRows.length > 0) {
           const { error } = await supabaseClient.from('follower_history').upsert(
              apiRows.filter(r => r.total !== null).map(r => ({ day: r.day, account: r.account, platform: r.platform, total: r.total, gained: r.gained, lost: r.lost })),
              { onConflict: 'day,account,platform' }
           );
           if (error) notes.push(`Snapshot save failed: ${error.message}`);
        }

        // Merge stored snapshots underneath the live values.
        let merged = apiRows;
        if (supabaseClient) {
           const { data, error } = await supabaseClient.from('follower_history')
              .select('day, account, platform, total, gained, lost')
              .gte('day', dateFrom).lte('day', dateTo);
           if (error) notes.push(`Snapshot read failed: ${error.message}`);
           if (data) {
              const seen = new Set(apiRows.map(r => `${r.day}|${r.account}|${r.platform}`));
              merged = [...apiRows, ...data.filter(r => !seen.has(`${r.day}|${r.account}|${r.platform}`))];
           }
        }

        setFollowerSeries(merged.filter(r => daysBetween(dateFrom, r.day) >= 0 && daysBetween(r.day, dateTo) >= 0));
        setFollowerNow(current);
        setFollowerNotes(notes);
     } finally {
        setFollowersLoading(false);
     }
  };

  useEffect(() => {
     if (viewMode === 'followers' && dateFrom && dateTo && apiKeys.token) fetchFollowers();
     // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, dateFrom, dateTo, account, apiKeys.token, apiKeys.czPageId, apiKeys.skPageId, supabaseClient]);

  const followerChartData = useMemo(() => {
     const buckets = {};
     const keys = new Set();
     [...followerSeries].sort((a, b) => a.day.localeCompare(b.day)).forEach(r => {
        const bk = bucketOf(r.day, followerGranularity);
        const seriesKey = `${r.account}_${r.platform}`;
        keys.add(seriesKey);
        buckets[bk] = buckets[bk] || { key: bk, name: bucketLabel(bk, followerGranularity) };
        // Totals are point-in-time: the last reading in the bucket wins.
        if (r.total !== null && r.total !== undefined) buckets[bk][seriesKey] = r.total;
        buckets[bk][`${seriesKey}_gained`] = (buckets[bk][`${seriesKey}_gained`] || 0) + (r.gained || 0);
     });
     return { rows: Object.values(buckets).sort((a, b) => a.key.localeCompare(b.key)), seriesKeys: [...keys].sort() };
  }, [followerSeries, followerGranularity]);

  const followerTotals = useMemo(() => {
     const out = {};
     followerSeries.forEach(r => {
        const k = `${r.account}_${r.platform}`;
        out[k] = out[k] || { account: r.account, platform: r.platform, first: null, last: null, gained: 0, firstDay: null, lastDay: null };
        out[k].gained += r.gained || 0;
        if (r.total === null || r.total === undefined) return;
        if (!out[k].firstDay || r.day < out[k].firstDay) { out[k].firstDay = r.day; out[k].first = r.total; }
        if (!out[k].lastDay || r.day > out[k].lastDay) { out[k].lastDay = r.day; out[k].last = r.total; }
     });
     return out;
  }, [followerSeries]);

  // ---------------------------------------------------------------------

  // Channel filter. When a single channel is selected, each post is rewritten to
  // that platform's own metrics so KPIs, charts and exports stay consistent.
  const visiblePosts = useMemo(() => {
     if (channelFilter === 'all') return posts;
     return posts
        .filter(p => (p.networks || []).includes(channelFilter))
        .map(p => {
           const m = p.platforms?.[channelFilter];
           if (!m) return { ...p, networks: [channelFilter] };
           return {
              ...p,
              networks: [channelFilter],
              network: channelFilter === 'instagram' ? 'ig' : 'fb',
              platforms: { [channelFilter]: m },
              metrics: { spend: m.spend, impressions: m.impressions, reach: m.reach, engagements: m.engagements, clicks: m.clicks, thruPlays: m.thruPlays, followers: m.followers },
           };
        });
  }, [posts, channelFilter]);

  // KPIs are derived from what is on screen so the channel filter applies to them too.
  const kpis = useMemo(() => visiblePosts.reduce((acc, p) => ({
     spend: acc.spend + p.metrics.spend,
     impressions: acc.impressions + p.metrics.impressions,
     reach: acc.reach + p.metrics.reach,
     thruPlays: acc.thruPlays + p.metrics.thruPlays,
     engagements: acc.engagements + p.metrics.engagements,
     linkClicks: acc.linkClicks + p.metrics.clicks,
     followers: acc.followers + p.metrics.followers,
  }), { spend: 0, impressions: 0, reach: 0, thruPlays: 0, engagements: 0, linkClicks: 0, followers: 0 }), [visiblePosts]);

  const channelCounts = useMemo(() => ({
     all: posts.length,
     facebook: posts.filter(p => (p.networks || []).includes('facebook')).length,
     instagram: posts.filter(p => (p.networks || []).includes('instagram')).length,
  }), [posts]);

  const uniqueMonthKeys = [...new Set(visiblePosts.map(p => p.monthKey))].sort();
  // Idempotent — safe to re-run at any time.
  const sqlSetupString = [
     `-- 1. Categories + post tags (single row, id = 1)`,
     `create table if not exists public.app_state (`,
     `  id integer primary key default 1,`,
     `  categories jsonb default '["Case Study", "Reference"]'::jsonb,`,
     `  tags jsonb default '{}'::jsonb`,
     `);`,
     `alter table public.app_state add column if not exists updated_at timestamptz default now();`,
     `insert into public.app_state (id) values (1) on conflict (id) do nothing;`,
     ``,
     `-- 2. Daily follower snapshots (keeps history beyond Meta's API windows)`,
     `create table if not exists public.follower_history (`,
     `  day date not null,`,
     `  account text not null,`,
     `  platform text not null,`,
     `  total integer,`,
     `  gained integer default 0,`,
     `  lost integer default 0,`,
     `  primary key (day, account, platform)`,
     `);`,
     ``,
     `-- 3. Let the dashboard's anon key read and write these two tables`,
     `grant select, insert, update on public.app_state to anon, authenticated;`,
     `grant select, insert, update on public.follower_history to anon, authenticated;`,
     ``,
     `alter table public.app_state enable row level security;`,
     `alter table public.follower_history enable row level security;`,
     ``,
     `drop policy if exists "dashboard access" on public.app_state;`,
     `create policy "dashboard access" on public.app_state`,
     `  for all to anon, authenticated using (true) with check (true);`,
     ``,
     `drop policy if exists "dashboard access" on public.follower_history;`,
     `create policy "dashboard access" on public.follower_history`,
     `  for all to anon, authenticated using (true) with check (true);`,
  ].join('\n');

  const generateChartData = () => {
     return uniqueMonthKeys.map(mk => {
        const monthPosts = visiblePosts.filter(p => {
           if (p.monthKey !== mk) return false;
           if (analyticsCategory === 'All') return true;
           if (analyticsCategory === 'Uncategorized') return !tags[p.id];
           return tags[p.id] === analyticsCategory;
        });

        const dataObj = { name: monthPosts[0]?.monthLabel || mk };

        if (account === 'both') {
           const czPosts = monthPosts.filter(p => p.accountTag === 'CZ');
           const skPosts = monthPosts.filter(p => p.accountTag === 'SK');
           
           selectedMetrics.forEach(mKey => {
              dataObj[`CZ_${mKey}`] = czPosts.reduce((s, p) => s + p.metrics[mKey], 0);
              dataObj[`SK_${mKey}`] = skPosts.reduce((s, p) => s + p.metrics[mKey], 0);
           });
        } else {
           selectedMetrics.forEach(mKey => {
              dataObj[mKey] = monthPosts.reduce((s, p) => s + p.metrics[mKey], 0);
           });
        }
        return dataObj;
     });
  };

  const exportToExcel = () => {
      if (visiblePosts.length === 0) { alert('No data to export. Load data first.'); return; }
      const wb = XLSX.utils.book_new();

      // --- Sheet 1: Summary ---
      const accountLabel = account === 'cz' ? 'Czech 🇨🇿' : account === 'sk' ? 'Slovak 🇸🇰' : 'Both 🇨🇿🇸🇰';
      const summaryRows = [
          ['Marketing Dashboard Report'],
          ['Account', accountLabel],
          ['Date Range', `${dateFrom} → ${dateTo}`],
          ['Campaign Filter', campaignFilter || '(none)'],
          ['Channel', channelFilter === 'all' ? 'All channels' : channelFilter === 'facebook' ? 'Facebook only' : 'Instagram only'],
          ['Generated', new Date().toLocaleString()],
          [],
          ['Metric', 'Value'],
          ['Amount Spent (€)', Number(kpis.spend.toFixed(2))],
          ['Impressions', kpis.impressions],
          ['Total Reach', kpis.reach],
          ['Engagements', kpis.engagements],
          ['Link Clicks', kpis.linkClicks],
          ['ThruPlays', kpis.thruPlays],
          ['Follows / Likes', kpis.followers],
          ['Total Posts', visiblePosts.length],
      ];
      const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
      summarySheet['!cols'] = [{ wch: 22 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

      // --- Sheet 2: Posts ---
      const postRows = visiblePosts.map(p => ({
          Country: p.accountTag,
          Network: p.networks ? p.networks.map(n => n === 'facebook' ? 'FB' : 'IG').join('+') : (p.network === 'ig' ? 'IG' : 'FB'),
          Category: tags[p.id] || 'Uncategorized',
          Month: p.monthLabel,
          Text: p.text,
          'Spend (€)': Number(p.metrics.spend.toFixed(2)),
          Impressions: p.metrics.impressions,
          Reach: p.metrics.reach,
          Engagements: p.metrics.engagements,
          Clicks: p.metrics.clicks,
          ThruPlays: p.metrics.thruPlays,
          Followers: p.metrics.followers,
          'Image URL': p.imageUrl,
      }));
      const postsSheet = XLSX.utils.json_to_sheet(postRows);
      postsSheet['!cols'] = [
          { wch: 8 }, { wch: 8 }, { wch: 18 }, { wch: 11 }, { wch: 60 },
          { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 12 },
          { wch: 9 }, { wch: 10 }, { wch: 10 }, { wch: 50 },
      ];
      XLSX.utils.book_append_sheet(wb, postsSheet, 'Posts');

      // --- Sheet 3: Monthly Breakdown ---
      const monthlyRows = uniqueMonthKeys.map(mk => {
          const monthPosts = visiblePosts.filter(p => p.monthKey === mk);
          const sums = monthPosts.reduce((acc, p) => ({
              spend: acc.spend + p.metrics.spend,
              impressions: acc.impressions + p.metrics.impressions,
              reach: acc.reach + p.metrics.reach,
              engagements: acc.engagements + p.metrics.engagements,
              clicks: acc.clicks + p.metrics.clicks,
              thruPlays: acc.thruPlays + p.metrics.thruPlays,
              followers: acc.followers + p.metrics.followers,
          }), { spend: 0, impressions: 0, reach: 0, engagements: 0, clicks: 0, thruPlays: 0, followers: 0 });
          return {
              Month: monthPosts[0]?.monthLabel || mk,
              'Posts': monthPosts.length,
              'Spend (€)': Number(sums.spend.toFixed(2)),
              Impressions: sums.impressions,
              Reach: sums.reach,
              Engagements: sums.engagements,
              Clicks: sums.clicks,
              ThruPlays: sums.thruPlays,
              Followers: sums.followers,
          };
      });
      const monthlySheet = XLSX.utils.json_to_sheet(monthlyRows);
      monthlySheet['!cols'] = [
          { wch: 14 }, { wch: 8 }, { wch: 11 }, { wch: 12 },
          { wch: 10 }, { wch: 12 }, { wch: 9 }, { wch: 10 }, { wch: 10 },
      ];
      XLSX.utils.book_append_sheet(wb, monthlySheet, 'Monthly Breakdown');

      // --- Sheet 4: Platform Breakdown (one row per ad × platform) ---
      const platformRows = [];
      visiblePosts.forEach(p => {
          if (!p.platforms) return;
          ['facebook', 'instagram'].forEach(plat => {
              const m = p.platforms[plat];
              if (!m) return;
              platformRows.push({
                  Country: p.accountTag,
                  Platform: plat === 'facebook' ? 'Facebook' : 'Instagram',
                  Category: tags[p.id] || 'Uncategorized',
                  Month: p.monthLabel,
                  Text: p.text,
                  'Spend (€)': Number(m.spend.toFixed(2)),
                  Impressions: m.impressions,
                  Reach: m.reach,
                  Engagements: m.engagements,
                  Clicks: m.clicks,
                  ThruPlays: m.thruPlays,
                  Followers: m.followers,
              });
          });
      });
      if (platformRows.length > 0) {
          const platSheet = XLSX.utils.json_to_sheet(platformRows);
          platSheet['!cols'] = [
              { wch: 8 }, { wch: 11 }, { wch: 18 }, { wch: 11 }, { wch: 60 },
              { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 12 },
              { wch: 9 }, { wch: 10 }, { wch: 10 },
          ];
          XLSX.utils.book_append_sheet(wb, platSheet, 'Platform Breakdown');
      }

      // --- Sheet 5: Follower Growth (only when the Followers view has loaded data) ---
      if (followerSeries.length > 0) {
          const followerRows = [...followerSeries]
              .sort((a, b) => a.day.localeCompare(b.day) || a.account.localeCompare(b.account) || a.platform.localeCompare(b.platform))
              .map(r => ({
                  Date: r.day,
                  Country: r.account,
                  Platform: r.platform === 'facebook' ? 'Facebook' : 'Instagram',
                  'Total Followers': r.total ?? '',
                  'New Followers': r.gained ?? 0,
                  'Unfollows': r.lost ?? 0,
              }));
          const folSheet = XLSX.utils.json_to_sheet(followerRows);
          folSheet['!cols'] = [{ wch: 12 }, { wch: 9 }, { wch: 11 }, { wch: 16 }, { wch: 15 }, { wch: 11 }];
          XLSX.utils.book_append_sheet(wb, folSheet, 'Followers');
      }

      const channelSuffix = channelFilter === 'all' ? '' : `-${channelFilter}`;
      const filename = `sto-${account}${channelSuffix}-marketing-report_${dateFrom}_to_${dateTo}.xlsx`;
      XLSX.writeFile(wb, filename);
  };

  const generateShareLink = () => {
      const payloadObj = {
          apiKeys, viewMode, account, dateFrom, dateTo, selectedMetrics, chartType, channelFilter
      };
      const encoded = btoa(JSON.stringify(payloadObj));
      const url = `${window.location.origin}${window.location.pathname}?payload=${encoded}`;
      navigator.clipboard.writeText(url);
      alert('Share link copied to clipboard! Anyone with this link can view the dashboard exactly as it is now.');
  };

  return (
    <>
      {showSettings && (
        <div
          onMouseDown={e => { if (e.target === e.currentTarget) closeSettings(); }}
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)' }}
        >
          <div style={{ background: '#fff', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '32px', width: '90%', maxWidth: '500px', boxShadow: '0 24px 48px rgba(0,0,0,0.2)', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
              <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}><Settings size={22}/> Configuration</h2>
              <button
                type="button"
                onClick={closeSettings}
                title="Close without applying (Esc)"
                aria-label="Close configuration"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '4px', borderRadius: '6px', display: 'flex' }}
              >
                <X size={20} />
              </button>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Meta Access Token</label>
              <input type="password" value={apiKeys.token} onChange={e => setApiKeys({...apiKeys, token: e.target.value})} className="control-input" style={{ width: '100%', background: '#f8fafc' }} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
              <div><label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Czech Ad API ID</label><input type="text" value={apiKeys.czId} onChange={e => setApiKeys({...apiKeys, czId: e.target.value})} className="control-input" style={{ width: '100%', background: '#f8fafc' }} /></div>
              <div><label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Slovak Ad API ID</label><input type="text" value={apiKeys.skId} onChange={e => setApiKeys({...apiKeys, skId: e.target.value})} className="control-input" style={{ width: '100%', background: '#f8fafc' }} /></div>
            </div>

            <hr style={{border: 'none', borderTop: '1px solid var(--border-color)', margin: '24px 0'}}/>
            <h3 style={{fontSize: '15px', marginBottom: '4px'}}>Follower Tracking 👥</h3>
            <p style={{fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px'}}>
              Facebook Page IDs for organic follower growth. The linked Instagram business account is detected automatically.
              The token needs <code>pages_read_engagement</code>, <code>read_insights</code>, <code>instagram_basic</code> and <code>instagram_manage_insights</code>.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
              <div><label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Czech Facebook Page ID</label><input type="text" value={apiKeys.czPageId} onChange={e => setApiKeys({...apiKeys, czPageId: e.target.value})} className="control-input" style={{ width: '100%', background: '#f8fafc' }} placeholder="1234567890" /></div>
              <div><label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Slovak Facebook Page ID</label><input type="text" value={apiKeys.skPageId} onChange={e => setApiKeys({...apiKeys, skPageId: e.target.value})} className="control-input" style={{ width: '100%', background: '#f8fafc' }} placeholder="1234567890" /></div>
            </div>

            <hr style={{border: 'none', borderTop: '1px solid var(--border-color)', margin: '24px 0'}}/>
            <h3 style={{fontSize: '15px', marginBottom: '12px'}}>Supabase Database ☁️</h3>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Project API URL</label>
                <input type="text" value={apiKeys.supabaseUrl} onChange={e => setApiKeys({...apiKeys, supabaseUrl: e.target.value})} className="control-input" style={{ width: '100%', background: '#f8fafc' }} placeholder="https://xyz.supabase.co" />
                {normalizeSupabaseUrl(apiKeys.supabaseUrl) !== apiKeys.supabaseUrl.trim() && apiKeys.supabaseUrl.trim() !== '' && (
                   <div style={{fontSize:'11px', color:'#047857', marginTop:'4px', lineHeight:1.4}}>
                      Will be used as <code>{normalizeSupabaseUrl(apiKeys.supabaseUrl)}</code>
                   </div>
                )}
              </div>
              <div><label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Anon API Key</label><input type="password" value={apiKeys.supabaseAnon} onChange={e => setApiKeys({...apiKeys, supabaseAnon: e.target.value})} className="control-input" style={{ width: '100%', background: '#f8fafc' }} placeholder="eyJh..." /></div>
            </div>

            {(apiKeys.supabaseUrl || syncStatus === 'error') && (
                <div style={{background: '#f1f5f9', padding: '12px', borderRadius: '8px', marginBottom:'24px', border: '1px solid #e2e8f0'}}>
                  <div style={{display:'flex', gap:'8px', alignItems:'flex-start', justifyContent:'space-between', marginBottom:'8px'}}>
                    <div style={{fontSize:'12px', color: 'var(--text-secondary)', fontWeight: 600}}>
                      Run this once in Supabase → SQL Editor. Safe to re-run.
                    </div>
                    <button className="btn" style={{padding:'4px 8px', flexShrink:0}} onClick={() => {navigator.clipboard.writeText(sqlSetupString); setCopiedSql(true); setTimeout(() => setCopiedSql(false), 2000)}}>{copiedSql ? <Check size={14}/> : <Copy size={14}/>}</button>
                  </div>
                  <pre style={{margin:0, fontSize:'11px', lineHeight:1.5, color:'#059669', overflow:'auto', maxHeight:'180px'}}>{sqlSetupString}</pre>
                  <div style={{fontSize:'11px', color:'var(--text-secondary)', marginTop:'8px', lineHeight:1.5}}>
                    These two tables are readable and writable by anyone holding the anon key — including anyone you send a Share View link to. Keep other tables in this project under their own RLS policies.
                  </div>
                </div>
            )}

            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>
                 Matrix Categories
                 <SyncBadge status={syncStatus} error={syncError} />
              </label>
              <div style={{display:'flex', flexWrap:'wrap', gap:'6px', marginBottom:'8px'}}>
                 {categories.map(cat => (
                    <span key={cat} style={{background: '#f1f5f9', border: '1px solid #e2e8f0', fontSize:'12px', padding:'4px 10px', borderRadius:'12px', display:'flex', alignItems:'center', gap:'6px', fontWeight: 600}}>
                       {cat} <strong style={{cursor:'pointer', opacity:0.6}} onClick={()=>handleRemoveCategory(cat)}>×</strong>
                    </span>
                 ))}
              </div>
              <div style={{display:'flex', gap:'8px'}}>
                <input type="text" className="control-input" placeholder="New category..." value={newCatName} onChange={e=>setNewCatName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAddCategory()} style={{flex:1, background: '#f8fafc'}}/>
                <button className="btn" onClick={handleAddCategory}>Add</button>
              </div>
              {syncStatus === 'error' && (
                 <div style={{marginTop:'10px', background:'#fef2f2', border:'1px solid #fecaca', color:'#b91c1c', borderRadius:'8px', padding:'10px', fontSize:'12px', lineHeight:1.5}}>
                    <strong>Supabase sync failed:</strong> {syncError}<br/>
                    Your categories are still saved in this browser. To sync across devices, run the SQL above
                    (it also disables Row Level Security, the usual cause of rejected writes).
                 </div>
              )}
              {syncStatus === 'local' && (
                 <div style={{marginTop:'10px', fontSize:'12px', color:'var(--text-secondary)'}}>
                    Saved in this browser only. Add Supabase credentials above to share categories across devices.
                 </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <button className="btn" style={{ justifyContent: 'center', padding: '14px 20px', fontSize: '15px' }} onClick={closeSettings}>Close</button>
              <button className="btn" style={{ flex: 1, justifyContent: 'center', padding: '14px', fontSize: '15px', background: 'var(--text-primary)', color: '#fff' }} onClick={saveSettings}>Apply &amp; Synchronize</button>
            </div>
          </div>
        </div>
      )}

      <header className="header">
        <div className="header-title">
           <img src={`${import.meta.env.BASE_URL}sto-logo.png`} alt="STO Logo" style={{ height: '32px', marginRight: '16px', objectFit: 'contain' }} />
           <div style={{display:'flex', background:'#f8fafc', p:4, borderRadius:'8px', overflow:'hidden', border: '1px solid var(--border-color)'}}>
              <div onClick={()=>setViewMode('overview')} style={{padding:'6px 12px', cursor:'pointer', display:'flex', alignItems:'center', gap:'6px', fontSize:'13px', background: viewMode === 'overview' ? '#e2e8f0' : 'transparent', fontWeight: viewMode === 'overview' ? 700 : 500}}><LayoutDashboard size={14}/> Overview</div>
              <div onClick={()=>setViewMode('matrix')} style={{padding:'6px 12px', cursor:'pointer', display:'flex', alignItems:'center', gap:'6px', fontSize:'13px', background: viewMode === 'matrix' ? '#e2e8f0' : 'transparent', fontWeight: viewMode === 'matrix' ? 700 : 500}}><Grid size={14}/> Matrix Report</div>
              <div onClick={()=>setViewMode('analytics')} style={{padding:'6px 12px', cursor:'pointer', display:'flex', alignItems:'center', gap:'6px', fontSize:'13px', background: viewMode === 'analytics' ? '#e2e8f0' : 'transparent', fontWeight: viewMode === 'analytics' ? 700 : 500}}><BarChart2 size={14}/> Analytics</div>
              <div onClick={()=>setViewMode('followers')} style={{padding:'6px 12px', cursor:'pointer', display:'flex', alignItems:'center', gap:'6px', fontSize:'13px', background: viewMode === 'followers' ? '#e2e8f0' : 'transparent', fontWeight: viewMode === 'followers' ? 700 : 500}}><Users size={14}/> Followers</div>
           </div>
           <SyncBadge status={syncStatus} error={syncError} />
        </div>
        <div className="controls">
          <select className="control-input" value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="cz">Czech 🇨🇿</option>
            <option value="sk">Slovak 🇸🇰</option>
            <option value="both">Both 🇨🇿🇸🇰</option>
          </select>
          <input type="date" className="control-input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          <span style={{ color: 'var(--text-secondary)' }}>to</span>
          <input type="date" className="control-input" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          <input type="text" className="control-input" placeholder="Filter..." value={campaignFilter} onChange={e => setCampaignFilter(e.target.value)} style={{ width: '80px' }} />
          <button className="btn" onClick={exportToExcel} disabled={visiblePosts.length === 0} style={{ background: '#f8fafc', color: '#0f172a', border: '1px solid #cbd5e1' }}><Download size={16} /> Export</button>
          <button className="btn" onClick={generateShareLink} style={{ background: '#f8fafc', color: '#0f172a', border: '1px solid #cbd5e1' }}><Share size={16} /> Share View</button>
          <button className="btn" onClick={() => setShowSettings(true)}><Settings size={16} /></button>
          <button className="btn" onClick={fetchData} disabled={loading} style={{ background: 'var(--text-primary)', color: '#fff' }}><RefreshCw size={16} className={loading ? 'spinner' : ''} /> {loading ? 'Fetching...' : 'Refresh'}</button>
        </div>
      </header>

      <main className="container">
        {viewMode !== 'followers' && (
           <div className="channel-bar">
              <span className="channel-bar-label">Channel</span>
              <ChannelSwitch value={channelFilter} onChange={setChannelFilter} counts={channelCounts} />
              {channelFilter !== 'all' && (
                 <span className="channel-bar-note">
                    Showing {channelFilter === 'facebook' ? 'Facebook' : 'Instagram'} delivery only — every metric below is that platform's share.
                 </span>
              )}
           </div>
        )}

        {viewMode === 'overview' ? (
           <>
            <div className="section-header">Overview Metrics</div>
            <div className="kpi-grid">
              {[
                { id: 'spend', label: 'Amount Spent', val: `€${kpis.spend.toFixed(2)}` },
                { id: 'impressions', label: 'Impressions', val: kpis.impressions.toLocaleString() },
                { id: 'reach', label: 'Total Reach', val: kpis.reach.toLocaleString() },
                { id: 'engagements', label: 'Engagements', val: kpis.engagements.toLocaleString() },
                { id: 'clicks', label: 'Link Clicks', val: kpis.linkClicks.toLocaleString() },
                { id: 'followers', label: 'Follows / Likes', val: kpis.followers.toLocaleString() }
              ].map(k => (
                <div key={k.id} className="kpi-card"><div className="kpi-title">{k.label}</div><div className="kpi-value">{k.val}</div></div>
              ))}
            </div>

            <div className="section-header">Ad Network Stream</div>
            {visiblePosts.length === 0 && (
               <div style={{color:'var(--text-secondary)', background:'#fff', border:'1px dashed var(--border-color)', borderRadius:'12px', padding:'32px', textAlign:'center'}}>
                  {posts.length === 0 ? 'No posts loaded for this date range.' : `No posts delivered on ${channelFilter === 'facebook' ? 'Facebook' : 'Instagram'} in this range.`}
               </div>
            )}
            <div className="posts-grid">
              {visiblePosts.map(post => (
                <div key={post.id} className="post-card">
                  <div className="post-visual platform-hover">
                    <select className="tag-selector" value={tags[post.id] || ''} onChange={(e) => assignTag(post.id, e.target.value)}>
                      <option value="">⚙️ Uncategorized</option>
                      {categories.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <img src={post.imageUrl} alt="Creative" onError={(e) => { e.target.onerror = null; e.target.src = 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?q=80&w=600&auto=format&fit=crop'; }}/>
                    <PlatformBadges networks={post.networks} variant="card" />
                    {post.platforms && Object.keys(post.platforms).length > 0 && <PlatformTooltip platforms={post.platforms} />}
                  </div>
                  <div className="post-content">
                    <div className="post-text">{post.text}</div>
                    <div className="post-metrics">
                      {[
                        { label: 'Spend', val: `€${post.metrics.spend.toFixed(2)}` },
                        { label: 'Impressions', val: formatNumber(post.metrics.impressions) },
                        { label: 'Reach', val: formatNumber(post.metrics.reach) },
                        { label: 'Engagements', val: formatNumber(post.metrics.engagements) },
                        { label: 'Clicks', val: formatNumber(post.metrics.clicks) },
                        { label: 'ThruPlays', val: formatNumber(post.metrics.thruPlays) },
                        { label: 'Follows', val: formatNumber(post.metrics.followers) }
                      ].map(m => (
                        <div key={m.label}><span className="post-metric-label">{m.label}</span><span className="post-metric-value">{m.val}</span></div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
           </>
        ) : viewMode === 'matrix' ? (
           <div className="matrix-wrapper">
              <div className="section-header">Categorical Timeline Report</div>
              {uniqueMonthKeys.length === 0 && <div style={{color:'var(--text-secondary)'}}>No data found for this date range.</div>}
              {uniqueMonthKeys.length > 0 && (
                <div className="matrix-container">
                  <table className="matrix-table">
                    <thead>
                      <tr>
                        <th className="sticky-cat" style={{width: '200px'}}>Concept Category</th>
                        {uniqueMonthKeys.map(mk => {
                            const sampleDate = visiblePosts.find(p => p.monthKey === mk)?.monthLabel || mk;
                            return <th key={mk} style={{minWidth: '320px'}}>{sampleDate}</th>
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {[...categories, ''].map(category => {
                         const rowPosts = visiblePosts.filter(p => category ? tags[p.id] === category : !tags[p.id]);
                         if (rowPosts.length === 0) return null; 
                         
                         return (
                           <tr key={category || 'uncat'}>
                             <td className="sticky-cat">
                               {category ? category : <span style={{opacity:0.5}}>Uncategorized</span>}
                             </td>
                             {uniqueMonthKeys.map(mk => {
                                const boxPosts = rowPosts.filter(p => p.monthKey === mk);
                                return (
                                  <td key={mk} className="matrix-cell">
                                    {boxPosts.length === 0 && <div style={{opacity:0.2, textAlign:'center', marginTop:'16px'}}>Empty</div>}
                                    {boxPosts.map(p => (
                                       <div key={p.id} className="matrix-mini-post platform-hover">
                                          <PlatformBadges networks={p.networks} variant="mini" />
                                          {p.platforms && Object.keys(p.platforms).length > 0 && <PlatformTooltip platforms={p.platforms} />}
                                          <img src={p.imageUrl} onError={(e) => { e.target.onerror = null; e.target.src = 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?q=80&w=600&auto=format&fit=crop'; }} />
                                          <div className="m-data">
                                             <div title={p.text} style={{fontWeight:700, fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', marginBottom:'6px', color:'#000'}}>{p.text}</div>
                                             
                                             <div className="m-kpi-grid">
                                                <div><span>Spend</span> €{p.metrics.spend.toFixed(0)}</div>
                                                <div><span>Impr</span> {formatNumber(p.metrics.impressions)}</div>
                                                <div><span>Rch</span> {formatNumber(p.metrics.reach)}</div>
                                                <div><span>Eng</span> {formatNumber(p.metrics.engagements)}</div>
                                                <div><span>Clk</span> {formatNumber(p.metrics.clicks)}</div>
                                                <div><span>Ply</span> {formatNumber(p.metrics.thruPlays)}</div>
                                                <div><span>Fol</span> {formatNumber(p.metrics.followers)}</div>
                                             </div>

                                          </div>
                                       </div>
                                    ))}
                                  </td>
                                )
                             })}
                           </tr>
                         )
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#f8fafc', borderTop: '2px solid #cbd5e1' }}>
                        <td className="sticky-cat" style={{ background: '#f8fafc', color: '#0f172a' }}>Monthly Totals</td>
                        {uniqueMonthKeys.map(mk => {
                            const monthPosts = visiblePosts.filter(p => p.monthKey === mk);
                            const sums = {
                                spend: monthPosts.reduce((s, p) => s + p.metrics.spend, 0),
                                impressions: monthPosts.reduce((s, p) => s + p.metrics.impressions, 0),
                                reach: monthPosts.reduce((s, p) => s + p.metrics.reach, 0),
                                engagements: monthPosts.reduce((s, p) => s + p.metrics.engagements, 0),
                                clicks: monthPosts.reduce((s, p) => s + p.metrics.clicks, 0),
                                thruPlays: monthPosts.reduce((s, p) => s + p.metrics.thruPlays, 0),
                                followers: monthPosts.reduce((s, p) => s + p.metrics.followers, 0),
                            };
                            return (
                                <td key={`total-${mk}`} className="matrix-cell" style={{ verticalAlign: 'bottom' }}>
                                   <div className="matrix-mini-post" style={{ background: '#fff', border: '2px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)', marginBottom: 0 }}>
                                      <div className="m-data">
                                         <div style={{fontWeight:800, fontSize:'14px', color:'#000', marginBottom:'4px'}}>Total Impact</div>
                                         <div className="m-kpi-grid" style={{background: 'transparent', border: 'none'}}>
                                            <div style={{color:'#000', background:'#f1f5f9'}}><span>Spend</span> €{sums.spend.toFixed(0)}</div>
                                            <div style={{color:'#000', background:'#f1f5f9'}}><span>Impr</span> {formatNumber(sums.impressions)}</div>
                                            <div style={{color:'#000', background:'#f1f5f9'}}><span>Rch</span> {formatNumber(sums.reach)}</div>
                                            <div style={{color:'#000', background:'#f1f5f9'}}><span>Eng</span> {formatNumber(sums.engagements)}</div>
                                            <div style={{color:'#000', background:'#f1f5f9'}}><span>Clk</span> {formatNumber(sums.clicks)}</div>
                                            <div style={{color:'#000', background:'#f1f5f9'}}><span>Ply</span> {formatNumber(sums.thruPlays)}</div>
                                            <div style={{color:'#000', background:'#f1f5f9'}}><span>Fol</span> {formatNumber(sums.followers)}</div>
                                         </div>
                                      </div>
                                   </div>
                                </td>
                            );
                        })}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
           </div>
        ) : viewMode === 'analytics' ? (
           <div className="matrix-wrapper">
              <div className="section-header" style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                 Analytics Engine
                 <div style={{display:'flex', gap:'12px', alignItems:'center', fontWeight: 'normal', fontSize: '13px'}}>
                    <select className="control-input" value={chartType} onChange={e=>setChartType(e.target.value)}>
                       <option value="bar">Bar Chart</option>
                       <option value="line">Line Chart</option>
                    </select>
                    <select className="control-input" value={analyticsCategory} onChange={e=>setAnalyticsCategory(e.target.value)}>
                       <option value="All">All Categories</option>
                       <option value="Uncategorized">Uncategorized Only</option>
                       {categories.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                 </div>
              </div>

              <div style={{background:'#fff', borderRadius:'16px', padding:'24px', border:'1px solid var(--border-color)', marginBottom:'24px'}}>
                 <div style={{display:'flex', flexWrap:'wrap', gap:'8px', marginBottom:'24px'}}>
                   {['spend', 'impressions', 'reach', 'engagements', 'clicks', 'thruPlays', 'followers'].map(mKey => {
                      const isActive = selectedMetrics.includes(mKey);
                      return (
                        <div key={mKey} onClick={() => {
                           if(isActive && selectedMetrics.length > 1) setSelectedMetrics(selectedMetrics.filter(m=>m!==mKey));
                           else if(!isActive) setSelectedMetrics([...selectedMetrics, mKey]);
                        }} style={{padding:'6px 14px', borderRadius:'20px', fontSize:'12px', fontWeight:600, cursor:'pointer', border: isActive ? '1px solid #ffd100' : '1px solid #e2e8f0', background: isActive ? '#fffbeb' : '#f8fafc', color: isActive ? '#b45309' : '#64748b', transition:'all 0.2s'}}>
                           {mKey.charAt(0).toUpperCase() + mKey.slice(1)}
                        </div>
                      )
                   })}
                 </div>

                 {uniqueMonthKeys.length === 0 ? <div style={{color:'var(--text-secondary)'}}>No data found.</div> : (
                   <div style={{height: '400px', width: '100%'}}>
                     <ResponsiveContainer width="100%" height="100%">
                        {chartType === 'bar' ? (
                           <BarChart data={generateChartData()} margin={{top:20, right:30, left:20, bottom:5}}>
                             <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                             <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill:'#64748b', fontSize:12}} dy={10} />
                             <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={{fill:'#64748b', fontSize:12}} tickFormatter={formatNumber} dx={-10} />
                             {selectedMetrics.length > 1 && <YAxis yAxisId="right" orientation="right" axisLine={false} tickLine={false} tick={{fill:'#64748b', fontSize:12}} tickFormatter={formatNumber} dx={10} />}
                             <Tooltip cursor={{fill: '#f8fafc'}} contentStyle={{borderRadius:'8px', border:'none', boxShadow:'0 10px 15px -3px rgba(0,0,0,0.1)'}} />
                             <Legend wrapperStyle={{paddingTop:'20px'}} />
                             {selectedMetrics.map((mKey, idx) => {
                                const yId = idx === 0 ? "left" : "right";
                                const STO_COLORS = ['#ffd100', '#1e293b', '#eb0229', '#3f88cc', '#ededed', '#10b981'];
                                if (account === 'both') {
                                   const czCol = ['#ffd100', '#eb0229', '#10b981'][idx % 3];
                                   const skCol = ['#1e293b', '#3f88cc', '#059669'][idx % 3];
                                   return (
                                     <React.Fragment key={mKey}>
                                       <Bar yAxisId={yId} dataKey={`CZ_${mKey}`} name={`CZ ${mKey}`} fill={czCol} radius={[4,4,0,0]} />
                                       <Bar yAxisId={yId} dataKey={`SK_${mKey}`} name={`SK ${mKey}`} fill={skCol} radius={[4,4,0,0]} />
                                     </React.Fragment>
                                   )
                                } else {
                                   return <Bar key={mKey} yAxisId={yId} dataKey={mKey} name={mKey} fill={STO_COLORS[idx % STO_COLORS.length]} radius={[4,4,0,0]} />
                                }
                             })}
                           </BarChart>
                        ) : (
                           <LineChart data={generateChartData()} margin={{top:20, right:30, left:20, bottom:5}}>
                             <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                             <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill:'#64748b', fontSize:12}} dy={10} />
                             <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={{fill:'#64748b', fontSize:12}} tickFormatter={formatNumber} dx={-10} />
                             {selectedMetrics.length > 1 && <YAxis yAxisId="right" orientation="right" axisLine={false} tickLine={false} tick={{fill:'#64748b', fontSize:12}} tickFormatter={formatNumber} dx={10} />}
                             <Tooltip contentStyle={{borderRadius:'8px', border:'none', boxShadow:'0 10px 15px -3px rgba(0,0,0,0.1)'}} />
                             <Legend wrapperStyle={{paddingTop:'20px'}} />
                             {selectedMetrics.map((mKey, idx) => {
                                const yId = idx === 0 ? "left" : "right";
                                const STO_COLORS = ['#ffd100', '#1e293b', '#eb0229', '#3f88cc', '#ededed', '#10b981'];
                                if (account === 'both') {
                                   const czCol = ['#ffd100', '#eb0229', '#10b981'][idx % 3];
                                   const skCol = ['#1e293b', '#3f88cc', '#059669'][idx % 3];
                                   return (
                                     <React.Fragment key={mKey}>
                                       <Line yAxisId={yId} type="monotone" dataKey={`CZ_${mKey}`} name={`CZ ${mKey}`} stroke={czCol} strokeWidth={3} dot={{r:4, strokeWidth:2}} activeDot={{r:6}} />
                                       <Line yAxisId={yId} type="monotone" dataKey={`SK_${mKey}`} name={`SK ${mKey}`} stroke={skCol} strokeWidth={3} dot={{r:4, strokeWidth:2}} activeDot={{r:6}} />
                                     </React.Fragment>
                                   )
                                } else {
                                   return <Line key={mKey} yAxisId={yId} type="monotone" dataKey={mKey} name={mKey} stroke={STO_COLORS[idx % STO_COLORS.length]} strokeWidth={3} dot={{r:4, strokeWidth:2}} activeDot={{r:6}} />
                                }
                             })}
                           </LineChart>
                        )}
                     </ResponsiveContainer>
                   </div>
                 )}
              </div>
           </div>
        ) : viewMode === 'followers' ? (
           <div className="matrix-wrapper">
              <div className="section-header" style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                 Follower Growth
                 <div style={{display:'flex', gap:'12px', alignItems:'center', fontWeight:'normal', fontSize:'13px'}}>
                    <select className="control-input" value={followerGranularity} onChange={e=>setFollowerGranularity(e.target.value)}>
                       <option value="day">Daily</option>
                       <option value="week">Weekly</option>
                       <option value="month">Monthly</option>
                    </select>
                    <button className="btn" onClick={fetchFollowers} disabled={followersLoading}>
                       <RefreshCw size={16} className={followersLoading ? 'spinner' : ''} /> {followersLoading ? 'Loading…' : 'Reload'}
                    </button>
                 </div>
              </div>

              <div className="kpi-grid" style={{marginBottom:'2rem'}}>
                 {followerNow.map(src => {
                    const stats = followerTotals[`${src.account}_${src.platform}`];
                    const delta = stats && stats.first !== null && stats.last !== null ? stats.last - stats.first : null;
                    return (
                       <div key={`${src.account}_${src.platform}`} className="kpi-card">
                          <div className="kpi-title" style={{display:'flex', alignItems:'center', gap:'6px'}}>
                             <span className={`platform-badge-mini ${src.platform === 'facebook' ? 'fb' : 'ig'}`}>{src.platform === 'facebook' ? 'FB' : 'IG'}</span>
                             {src.account} · {src.handle}
                          </div>
                          <div className="kpi-value">{src.total.toLocaleString()}</div>
                          <div style={{fontSize:'12px', marginTop:'8px', color: delta > 0 ? '#047857' : delta < 0 ? '#b91c1c' : 'var(--text-secondary)', fontWeight:600}}>
                             {delta === null
                                ? `+${(stats?.gained || 0).toLocaleString()} new in range`
                                : `${delta >= 0 ? '+' : ''}${delta.toLocaleString()} in range`}
                          </div>
                       </div>
                    );
                 })}
              </div>

              {!apiKeys.token || (!apiKeys.czPageId && !apiKeys.skPageId) ? (
                 <div style={{background:'#f8fafc', border:'1px dashed var(--border-color)', borderRadius:'12px', padding:'20px', marginBottom:'24px', fontSize:'13px', lineHeight:1.7, color:'var(--text-secondary)'}}>
                    <strong style={{color:'var(--text-primary)'}}>Not configured yet.</strong> Open <Settings size={13} style={{verticalAlign:'-2px'}}/> Settings and fill in
                    the Meta access token plus at least one Facebook Page ID. The Instagram business account linked to that page is picked up automatically.
                    <div style={{marginTop:'8px'}}>Find the Page ID under your Facebook Page → Settings → About, or via <code>/me/accounts</code> in the Graph API Explorer.</div>
                 </div>
              ) : null}

              {followerNotes.length > 0 && (
                 <div style={{background:'#fffbeb', border:'1px solid #fde68a', color:'#92400e', borderRadius:'12px', padding:'14px 16px', marginBottom:'24px', fontSize:'13px', lineHeight:1.6}}>
                    <strong style={{display:'flex', alignItems:'center', gap:'6px', marginBottom:'6px'}}><TriangleAlert size={14}/> Follower data notes</strong>
                    <ul style={{margin:0, paddingLeft:'18px'}}>
                       {followerNotes.map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                 </div>
              )}

              <div style={{background:'#fff', borderRadius:'16px', padding:'24px', border:'1px solid var(--border-color)', marginBottom:'24px'}}>
                 <div style={{fontWeight:700, marginBottom:'4px'}}>Total followers over time</div>
                 <div style={{fontSize:'12px', color:'var(--text-secondary)', marginBottom:'20px'}}>
                    Facebook totals come from Page Insights. Instagram history is reconstructed from daily new-follower counts
                    (Meta exposes only the last 30 days), so older Instagram points appear once snapshots have been recorded.
                 </div>
                 {followerChartData.rows.length === 0 ? (
                    <div style={{color:'var(--text-secondary)'}}>{followersLoading ? 'Loading…' : 'No follower data for this range yet.'}</div>
                 ) : (
                    <div style={{height:'360px', width:'100%'}}>
                       <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={followerChartData.rows} margin={{top:20, right:30, left:20, bottom:5}}>
                             <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                             <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill:'#64748b', fontSize:12}} dy={10} minTickGap={20} />
                             <YAxis axisLine={false} tickLine={false} tick={{fill:'#64748b', fontSize:12}} tickFormatter={formatNumber} dx={-10} domain={['auto','auto']} />
                             <Tooltip contentStyle={{borderRadius:'8px', border:'none', boxShadow:'0 10px 15px -3px rgba(0,0,0,0.1)'}} formatter={(v) => Number(v).toLocaleString()} />
                             <Legend wrapperStyle={{paddingTop:'20px'}} />
                             {followerChartData.seriesKeys.map(k => (
                                <Line key={k} type="monotone" dataKey={k} name={FOLLOWER_LABELS(k)} stroke={FOLLOWER_COLORS[k] || '#1e293b'} strokeWidth={3} dot={false} activeDot={{r:5}} connectNulls />
                             ))}
                          </LineChart>
                       </ResponsiveContainer>
                    </div>
                 )}
              </div>

              <div style={{background:'#fff', borderRadius:'16px', padding:'24px', border:'1px solid var(--border-color)'}}>
                 <div style={{fontWeight:700, marginBottom:'20px'}}>New followers per {followerGranularity === 'day' ? 'day' : followerGranularity === 'week' ? 'week' : 'month'}</div>
                 {followerChartData.rows.length === 0 ? (
                    <div style={{color:'var(--text-secondary)'}}>No data.</div>
                 ) : (
                    <div style={{height:'320px', width:'100%'}}>
                       <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={followerChartData.rows} margin={{top:20, right:30, left:20, bottom:5}}>
                             <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                             <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill:'#64748b', fontSize:12}} dy={10} minTickGap={20} />
                             <YAxis axisLine={false} tickLine={false} tick={{fill:'#64748b', fontSize:12}} tickFormatter={formatNumber} dx={-10} />
                             <Tooltip cursor={{fill:'#f8fafc'}} contentStyle={{borderRadius:'8px', border:'none', boxShadow:'0 10px 15px -3px rgba(0,0,0,0.1)'}} formatter={(v) => Number(v).toLocaleString()} />
                             <Legend wrapperStyle={{paddingTop:'20px'}} />
                             {followerChartData.seriesKeys.map(k => (
                                <Bar key={k} dataKey={`${k}_gained`} name={FOLLOWER_LABELS(k)} fill={FOLLOWER_COLORS[k] || '#1e293b'} radius={[4,4,0,0]} />
                             ))}
                          </BarChart>
                       </ResponsiveContainer>
                    </div>
                 )}
              </div>
           </div>
        ) : null}
      </main>

      <footer style={{ textAlign: 'center', padding: '4rem 1rem', borderTop: '1px solid var(--border-color)', marginTop: 'auto', background: '#fff' }}>
         <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>Engineered by</div>
         <img src={`${import.meta.env.BASE_URL}opus-logo.png`} alt="Opus Magnus" style={{ height: '36px', filter: 'invert(1)', objectFit: 'contain' }} />
      </footer>
    </>
  );
};
export default App;
