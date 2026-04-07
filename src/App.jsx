import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { RefreshCw, LayoutDashboard, Settings } from 'lucide-react';

const App = () => {
  const [account, setAccount] = useState('cz');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [campaignFilter, setCampaignFilter] = useState('Post'); 
  const [posts, setPosts] = useState([]);
  const [kpis, setKpis] = useState({
    spend: 0, impressions: 0, reach: 0, thruPlays: 0, engagements: 0, linkClicks: 0, followers: 0
  });

  const [showSettings, setShowSettings] = useState(false);
  const [apiKeys, setApiKeys] = useState({ token: '', czId: '', skId: '' });

  useEffect(() => {
    const today = new Date();
    const lastMonth = new Date();
    lastMonth.setDate(today.getDate() - 30);
    setDateTo(today.toISOString().split('T')[0]);
    setDateFrom(lastMonth.toISOString().split('T')[0]);

    // Pre-load keys securely from browser storage to bypass .env.local on GitHub Pages
    const saved = localStorage.getItem('meta_dashboard_keys');
    if (saved) {
      setApiKeys(JSON.parse(saved));
    } else {
      setShowSettings(true); // Pop the settings screen on initial load
    }
  }, []);

  useEffect(() => {
    if (dateFrom && dateTo && apiKeys.token) {
      fetchData();
    }
  }, [dateFrom, dateTo, account, apiKeys.token]);

  const saveSettings = () => {
    localStorage.setItem('meta_dashboard_keys', JSON.stringify(apiKeys));
    setShowSettings(false);
    if (apiKeys.token) fetchData();
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const API_TOKEN = apiKeys.token;
      let accountId = account === 'cz' ? apiKeys.czId : apiKeys.skId;
      
      if (!API_TOKEN || !accountId) {
        setShowSettings(true);
        setLoading(false);
        return;
      }
      if (!accountId.startsWith('act_')) accountId = 'act_' + accountId;

      // STAGE 1: Fetch directly from Facebook Graph API (Proxy removed for statically hosted environment)
      const insightsResponse = await axios.get(`https://graph.facebook.com/v25.0/${accountId}/insights`, {
        params: {
          access_token: API_TOKEN,
          level: 'ad',
          time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
          limit: 150, 
          fields: 'ad_id,ad_name,campaign_name,spend,impressions,reach,inline_link_clicks,actions,video_play_actions'
        }
      });

      const insightsData = insightsResponse.data.data;
      if (!insightsData || insightsData.length === 0) {
        setPosts([]); setKpis({ spend: 0, impressions: 0, reach: 0, thruPlays: 0, engagements: 0, linkClicks: 0, followers: 0 });
        setLoading(false); return;
      }

      const filteredInsights = insightsData.filter(ins => {
        if (!campaignFilter) return true;
        const cName = ins.campaign_name?.toLowerCase() || '';
        if (campaignFilter.startsWith('-')) {
            return !cName.includes(campaignFilter.substring(1).toLowerCase().trim());
        }
        return cName.includes(campaignFilter.toLowerCase().trim());
      });

      if (filteredInsights.length === 0) {
        setPosts([]); setKpis({ spend: 0, impressions: 0, reach: 0, thruPlays: 0, engagements: 0, linkClicks: 0, followers: 0 });
        setLoading(false); return;
      }

      // STAGE 2: Direct batch creatives pull
      const adIds = filteredInsights.map(i => i.ad_id).join(',');
      const creativesResponse = await axios.get(`https://graph.facebook.com/v25.0/`, {
        params: {
          access_token: API_TOKEN,
          ids: adIds,
          fields: 'creative{image_url,thumbnail_url,body,instagram_permalink_url,source_instagram_media_id}'
        }
      });

      const creativesData = creativesResponse.data;

      // STAGE 3: Compilation
      let newKpis = { spend: 0, impressions: 0, reach: 0, thruPlays: 0, engagements: 0, linkClicks: 0, followers: 0 };
      
      const newPosts = filteredInsights.map(ins => {
        const adNode = creativesData[ins.ad_id] || {};
        const creative = adNode.creative || {};
        
        const getAction = (actions, type) => {
            const action = (actions || []).find(a => a.action_type === type);
            return action ? parseInt(action.value) : 0;
        };

        const spend = parseFloat(ins.spend || 0);
        const impressions = parseInt(ins.impressions || 0);
        const reach = parseInt(ins.reach || 0);
        const linkClicks = parseInt(ins.inline_link_clicks || 0);
        const postEngagement = getAction(ins.actions, 'post_engagement');
        const thruPlays = getAction(ins.actions, 'video_view');
        const followers = getAction(ins.actions, 'like');

        newKpis.spend += spend;
        newKpis.impressions += impressions;
        newKpis.reach += reach;
        newKpis.linkClicks += linkClicks;
        newKpis.engagements += postEngagement;
        newKpis.thruPlays += thruPlays;
        newKpis.followers += followers;

        const cNameLower = (ins.campaign_name || '').toLowerCase();
        const originatedOnIg = creative.source_instagram_media_id || cNameLower.includes('instagram') || cNameLower.includes('reel');

        return {
            id: ins.ad_id,
            network: originatedOnIg ? 'ig' : 'fb',
            text: creative.body || ins.ad_name,
            imageUrl: creative.image_url || creative.thumbnail_url || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?q=80&w=600&auto=format&fit=crop',
            metrics: {
                spend: `€${spend.toFixed(2)}`, 
                impressions: impressions.toLocaleString(),
                reach: reach.toLocaleString(),
                engagements: postEngagement.toLocaleString(), 
                clicks: linkClicks.toLocaleString(),
                thruPlays: thruPlays.toLocaleString(),
                followers: followers.toLocaleString()
            }
        };
      }).filter(post => post.text);

      setKpis(newKpis);
      setPosts(newPosts);

    } catch (err) {
      console.error(err);
      if (err.response?.status === 401 || err.response?.status === 400) {
          setShowSettings(true); // Popup if token invalid
      }
      const metaError = err.response?.data?.error?.message || err.message;
      alert('API Error: ' + metaError + '\n\nCheck your console for more details.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {showSettings && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)' }}>
          <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '32px', width: '90%', maxWidth: '440px', boxShadow: '0 24px 48px rgba(0,0,0,0.5)' }}>
            <h2 style={{ margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Settings size={22}/> Configuration
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.5', marginBottom: '24px' }}>
              Your dashboard is now securely tailored for static hosting on GitHub Pages. 
              Please enter your Meta credentials below. These are saved <strong>strictly locally</strong> in your browser and are never transmitted to our servers.
            </p>
            
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px', color: 'var(--text-secondary)' }}>System User Access Token</label>
              <input type="password" value={apiKeys.token} onChange={e => setApiKeys({...apiKeys, token: e.target.value})} className="control-input" style={{ width: '100%' }} placeholder="EAA..." />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px', color: 'var(--text-secondary)' }}>Czech Ad Account ID</label>
                <input type="text" value={apiKeys.czId} onChange={e => setApiKeys({...apiKeys, czId: e.target.value})} className="control-input" style={{ width: '100%' }} placeholder="16210..." />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px', color: 'var(--text-secondary)' }}>Slovak Ad Account ID</label>
                <input type="text" value={apiKeys.skId} onChange={e => setApiKeys({...apiKeys, skId: e.target.value})} className="control-input" style={{ width: '100%' }} placeholder="..." />
              </div>
            </div>

            <button className="btn" style={{ width: '100%', justifyContent: 'center', padding: '12px', fontSize: '14px', height: 'auto' }} onClick={saveSettings}>
              Apply & Save Configuration
            </button>
            <div style={{marginTop:'12px', textAlign:'center'}}>
               <span style={{ fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer', opacity: 0.7 }} onClick={() => setShowSettings(false)}>Cancel</span>
            </div>
          </div>
        </div>
      )}

      <header className="header">
        <div className="header-title">
          <LayoutDashboard size={24} /> Dashboard
        </div>
        <div className="controls">
          <select className="control-input" value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="cz">Czech Account 🇨🇿</option>
            <option value="sk">Slovak Account 🇸🇰</option>
          </select>
          <input type="date" className="control-input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          <span style={{ color: 'var(--text-secondary)' }}>to</span>
          <input type="date" className="control-input" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          <input type="text" className="control-input" placeholder="Filter campaigns..." title="Type '-performance' to exclude, or 'post' to include" value={campaignFilter} onChange={e => setCampaignFilter(e.target.value)} style={{ width: '140px' }} />
          
          <button className="btn" onClick={() => setShowSettings(true)} title="Settings" style={{ padding: '0 8px' }}>
             <Settings size={16} />
          </button>
          
          <button className="btn" onClick={fetchData} disabled={loading}>
             <RefreshCw size={16} className={loading ? 'spinner' : ''} /> {loading ? 'Fetching...' : 'Refresh'}
          </button>
        </div>
      </header>

      <main className="container">
        <div className="section-header">Overview Metrics</div>
        <div className="kpi-grid">
          {[
            { id: 'spend', label: 'Amount Spent', val: `€${kpis.spend.toFixed(2)}` },
            { id: 'impressions', label: 'Impressions', val: kpis.impressions.toLocaleString() },
            { id: 'reach', label: 'Total Reach', val: kpis.reach.toLocaleString() },
            { id: 'engagements', label: 'Engagements', val: kpis.engagements.toLocaleString() },
            { id: 'clicks', label: 'Link Clicks', val: kpis.linkClicks.toLocaleString() },
            { id: 'plays', label: 'ThruPlays', val: kpis.thruPlays.toLocaleString() },
            { id: 'followers', label: 'Follows / Likes', val: kpis.followers.toLocaleString() }
          ].map(k => (
            <div key={k.id} className="kpi-card">
              <div className="kpi-title">{k.label}</div>
              <div className="kpi-value">{k.val}</div>
            </div>
          ))}
        </div>

        <div className="section-header">Boosted Posts Performance</div>
        <div className="posts-grid">
          {posts.map(post => (
             <div key={post.id} className="post-card">
              <div className="post-visual">
                <img src={post.imageUrl} alt="Ad Creative"/>
                <div className="post-network-icon" style={{ background: post.network === 'ig' ? 'linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)' : '#1877F2', width: 'auto', padding: '6px 12px', borderRadius: '20px', display: 'flex', alignItems: 'center', gap: '6px', top: '12px', right: '12px' }}>
                  {post.network === 'ig' ? (
                     <>
                       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="20" x="2" y="2" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/></svg>
                       <span style={{color: '#fff', fontSize: '12px', fontWeight: '600'}}>Instagram</span>
                     </>
                  ) : (
                     <>
                       <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><path d="M22.675 0H1.325C.593 0 0 .593 0 1.325v21.351C0 23.407.593 24 1.325 24h11.49v-9.294H9.69v-3.622h3.125V8.413c0-3.1 1.893-4.788 4.659-4.788 1.325 0 2.463.099 2.795.143v3.24l-1.918.001c-1.504 0-1.794.715-1.794 1.763v2.309h3.587l-.467 3.622h-3.12V24h6.116c.73 0 1.323-.593 1.323-1.325V1.325C24 .593 23.407 0 22.675 0z"/></svg>
                       <span style={{color: '#fff', fontSize: '12px', fontWeight: '600'}}>Facebook</span>
                     </>
                  )}
                </div>
              </div>
              <div className="post-content">
                <div className="post-text">{post.text}</div>
                <div className="post-metrics">
                  {[
                    { label: 'Spend', val: post.metrics.spend },
                    { label: 'Impressions', val: post.metrics.impressions },
                    { label: 'Reach', val: post.metrics.reach },
                    { label: 'Engagements', val: post.metrics.engagements },
                    { label: 'Clicks', val: post.metrics.clicks },
                    { label: 'ThruPlays', val: post.metrics.thruPlays },
                    { label: 'Follows', val: post.metrics.followers }
                  ].map(m => (
                    <div key={m.label}>
                      <span className="post-metric-label">{m.label}</span>
                      <span className="post-metric-value">{m.val}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </>
  );
};
export default App;
