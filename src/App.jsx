import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { RefreshCw, LayoutDashboard, Settings, Grid, Copy, Check } from 'lucide-react';

const formatNumber = (num) => {
    if (num === null || num === undefined) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return num.toString();
};

const App = () => {
  const [account, setAccount] = useState('cz');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [campaignFilter, setCampaignFilter] = useState('Post'); 
  const [viewMode, setViewMode] = useState('overview');

  const [posts, setPosts] = useState([]);
  const [kpis, setKpis] = useState({ spend: 0, impressions: 0, reach: 0, thruPlays: 0, engagements: 0, linkClicks: 0, followers: 0 });

  const [showSettings, setShowSettings] = useState(false);
  const [apiKeys, setApiKeys] = useState({ token: '', czId: '', skId: '', supabaseUrl: '', supabaseAnon: '' });
  
  const [supabaseClient, setSupabaseClient] = useState(null);
  const [categories, setCategories] = useState(['Case Study', 'Reference']);
  const [tags, setTags] = useState({});
  const [newCatName, setNewCatName] = useState('');
  const [copiedSql, setCopiedSql] = useState(false);

  useEffect(() => {
    const today = new Date();
    const lastMonth = new Date();
    lastMonth.setDate(today.getDate() - 30);
    setDateTo(today.toISOString().split('T')[0]);
    setDateFrom(lastMonth.toISOString().split('T')[0]);

    const saved = localStorage.getItem('meta_dashboard_keys');
    if (saved) {
      const parsed = JSON.parse(saved);
      setApiKeys(parsed);
      
      if (parsed.supabaseUrl && parsed.supabaseAnon) {
         try {
           const client = createClient(parsed.supabaseUrl, parsed.supabaseAnon);
           setSupabaseClient(client);
           loadCloudState(client);
         } catch(e) { console.error(e); }
      }
    } else { setShowSettings(true); }
  }, []);

  const loadCloudState = async (client) => {
      const { data } = await client.from('app_state').select('categories, tags').eq('id', 1).single();
      if (data) {
          if (data.categories) setCategories(data.categories);
          if (data.tags) setTags(data.tags);
      }
  };

  const syncCloudState = async (newCategories, newTags) => {
      if (!supabaseClient) return;
      await supabaseClient.from('app_state').upsert({ id: 1, categories: newCategories, tags: newTags });
  };

  const handleAddCategory = () => {
    if (!newCatName.trim() || categories.includes(newCatName.trim())) return;
    const nextList = [...categories, newCatName.trim()];
    setCategories(nextList); setNewCatName(''); syncCloudState(nextList, tags);
  };

  const handleRemoveCategory = (cat) => {
    const nextList = categories.filter(c => c !== cat);
    setCategories(nextList); syncCloudState(nextList, tags);
  };

  const assignTag = (postId, categoryName) => {
    const nextTags = { ...tags, [postId]: categoryName };
    if (!categoryName) delete nextTags[postId];
    setTags(nextTags); syncCloudState(categories, nextTags);
  };

  useEffect(() => {
    if (dateFrom && dateTo && apiKeys.token) fetchData();
  }, [dateFrom, dateTo, account]);

  const saveSettings = () => {
    localStorage.setItem('meta_dashboard_keys', JSON.stringify(apiKeys));
    setShowSettings(false);
    if (apiKeys.supabaseUrl && apiKeys.supabaseAnon) {
       const client = createClient(apiKeys.supabaseUrl, apiKeys.supabaseAnon);
       setSupabaseClient(client); loadCloudState(client);
    }
    if (apiKeys.token) fetchData();
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const API_TOKEN = apiKeys.token;
      let accountId = account === 'cz' ? apiKeys.czId : apiKeys.skId;
      if (!API_TOKEN || !accountId) { setShowSettings(true); setLoading(false); return; }
      if (!accountId.startsWith('act_')) accountId = 'act_' + accountId;

      const insightsResponse = await axios.get(`https://graph.facebook.com/v25.0/${accountId}/insights`, {
        params: {
          access_token: API_TOKEN, level: 'ad', time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
          limit: 150, fields: 'ad_id,ad_name,campaign_name,spend,impressions,reach,inline_link_clicks,actions,video_play_actions'
        }
      });

      const insightsData = insightsResponse.data.data;
      if (!insightsData || insightsData.length === 0) { setPosts([]); setKpis({ spend: 0, impressions: 0, reach: 0, thruPlays: 0, engagements: 0, linkClicks: 0, followers: 0 }); setLoading(false); return; }

      const filteredInsights = insightsData.filter(ins => {
        if (!campaignFilter) return true;
        const cName = ins.campaign_name?.toLowerCase() || '';
        return campaignFilter.startsWith('-') ? !cName.includes(campaignFilter.substring(1).trim()) : cName.includes(campaignFilter.toLowerCase().trim());
      });

      if (filteredInsights.length === 0) { setPosts([]); setLoading(false); return; }

      const adIds = filteredInsights.map(i => i.ad_id).join(',');
      const creativesResponse = await axios.get(`https://graph.facebook.com/v25.0/`, {
        params: {
          access_token: API_TOKEN, ids: adIds,
          fields: 'created_time,creative{image_url,thumbnail_url,body,instagram_permalink_url,source_instagram_media_id,object_story_spec}'
        }
      });

      const creativesData = creativesResponse.data;
      let newKpis = { spend: 0, impressions: 0, reach: 0, thruPlays: 0, engagements: 0, linkClicks: 0, followers: 0 };
      
      const newPosts = filteredInsights.map(ins => {
        const adNode = creativesData[ins.ad_id] || {};
        const creative = adNode.creative || {};
        const getAction = (actions, type) => { const action = (actions || []).find(a => a.action_type === type); return action ? parseInt(action.value) : 0; };

        const spend = parseFloat(ins.spend || 0); const impressions = parseInt(ins.impressions || 0);
        const reach = parseInt(ins.reach || 0); const linkClicks = parseInt(ins.inline_link_clicks || 0);
        const postEngagement = getAction(ins.actions, 'post_engagement'); const thruPlays = getAction(ins.actions, 'video_view');
        const followers = getAction(ins.actions, 'like');

        newKpis.spend += spend; newKpis.impressions += impressions; newKpis.reach += reach;
        newKpis.linkClicks += linkClicks; newKpis.engagements += postEngagement; newKpis.thruPlays += thruPlays; newKpis.followers += followers;

        const cTime = adNode.created_time ? new Date(adNode.created_time) : new Date(dateFrom);
        const monthKey = `${cTime.getFullYear()}-${String(cTime.getMonth()+1).padStart(2, '0')}`;
        const monthLabel = cTime.toLocaleString('default', { month: 'short', year: 'numeric' });

        let hdImage = creative.image_url;
        if (creative.object_story_spec) {
            const spec = creative.object_story_spec;
            if (spec.video_data && spec.video_data.image_url) {
                hdImage = spec.video_data.image_url;
            } else if (spec.link_data && spec.link_data.child_attachments && spec.link_data.child_attachments.length > 0) {
                hdImage = spec.link_data.child_attachments[0].image_url || spec.link_data.child_attachments[0].picture || hdImage;
            } else if (spec.photo_data && spec.photo_data.url) {
                hdImage = spec.photo_data.url;
            } else if (spec.link_data && spec.link_data.picture && !hdImage) {
                hdImage = spec.link_data.picture;
            }
        }
        
        const bestImageUrl = hdImage || creative.thumbnail_url || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?q=80&w=600&auto=format&fit=crop';

        return {
            id: ins.ad_id, monthKey, monthLabel,
            network: (creative.source_instagram_media_id || (ins.campaign_name || '').toLowerCase().includes('instagram')) ? 'ig' : 'fb',
            text: creative.body || ins.ad_name,
            imageUrl: bestImageUrl,
            metrics: { spend, impressions, reach, engagements: postEngagement, clicks: linkClicks, thruPlays, followers }
        };
      }).filter(post => post.text);

      setKpis(newKpis); setPosts(newPosts);
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 400) setShowSettings(true);
      alert('API Error: ' + (err.response?.data?.error?.message || err.message));
    } finally { setLoading(false); }
  };

  const uniqueMonthKeys = [...new Set(posts.map(p => p.monthKey))].sort();
  const sqlSetupString = `create table if not exists app_state (\n  id integer primary key default 1,\n  categories jsonb default '["Case Study", "Reference"]'::jsonb,\n  tags jsonb default '{}'::jsonb\n);\ninsert into app_state (id) values (1) on conflict do nothing;`;

  return (
    <>
      {showSettings && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)' }}>
          <div style={{ background: '#fff', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '32px', width: '90%', maxWidth: '500px', boxShadow: '0 24px 48px rgba(0,0,0,0.2)', maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 style={{ margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: '8px' }}><Settings size={22}/> Configuration</h2>
            
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Meta Access Token</label>
              <input type="password" value={apiKeys.token} onChange={e => setApiKeys({...apiKeys, token: e.target.value})} className="control-input" style={{ width: '100%', background: '#f8fafc' }} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
              <div><label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Czech Ad API ID</label><input type="text" value={apiKeys.czId} onChange={e => setApiKeys({...apiKeys, czId: e.target.value})} className="control-input" style={{ width: '100%', background: '#f8fafc' }} /></div>
              <div><label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Slovak Ad API ID</label><input type="text" value={apiKeys.skId} onChange={e => setApiKeys({...apiKeys, skId: e.target.value})} className="control-input" style={{ width: '100%', background: '#f8fafc' }} /></div>
            </div>

            <hr style={{border: 'none', borderTop: '1px solid var(--border-color)', margin: '24px 0'}}/>
            <h3 style={{fontSize: '15px', marginBottom: '12px'}}>Supabase Database ☁️</h3>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
              <div><label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Project API URL</label><input type="text" value={apiKeys.supabaseUrl} onChange={e => setApiKeys({...apiKeys, supabaseUrl: e.target.value})} className="control-input" style={{ width: '100%', background: '#f8fafc' }} placeholder="https://xyz.supabase.co" /></div>
              <div><label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Anon API Key</label><input type="password" value={apiKeys.supabaseAnon} onChange={e => setApiKeys({...apiKeys, supabaseAnon: e.target.value})} className="control-input" style={{ width: '100%', background: '#f8fafc' }} placeholder="eyJh..." /></div>
            </div>

            {apiKeys.supabaseUrl && (
                <div style={{background: '#f1f5f9', padding: '12px', borderRadius: '8px', marginBottom:'24px', border: '1px solid #e2e8f0'}}>
                  <div style={{fontSize:'12px', marginBottom:'8px', color: 'var(--text-secondary)', fontWeight: 600}}>Run this SQL in your Supabase Editor once:</div>
                  <div style={{display:'flex', gap: '8px', alignItems:'flex-start'}}>
                    <pre style={{margin:0, fontSize:'11px', color:'#059669', overflowX:'auto'}}>{sqlSetupString}</pre>
                    <button className="btn" style={{padding:'4px 8px'}} onClick={() => {navigator.clipboard.writeText(sqlSetupString); setCopiedSql(true); setTimeout(() => setCopiedSql(false), 2000)}}>{copiedSql ? <Check size={14}/> : <Copy size={14}/>}</button>
                  </div>
                </div>
            )}

            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '6px' }}>Matrix Categories</label>
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
            </div>

            <button className="btn" style={{ width: '100%', justifyContent: 'center', padding: '14px', fontSize: '15px', background: 'var(--text-primary)', color: '#fff' }} onClick={saveSettings}>Apply & Synchronize</button>
          </div>
        </div>
      )}

      <header className="header">
        <div className="header-title">
           <img src={`${import.meta.env.BASE_URL}sto-logo.png`} alt="STO Logo" style={{ height: '32px', marginRight: '16px', objectFit: 'contain' }} />
           <div style={{display:'flex', background:'#f8fafc', p:4, borderRadius:'8px', overflow:'hidden', border: '1px solid var(--border-color)'}}>
              <div onClick={()=>setViewMode('overview')} style={{padding:'6px 12px', cursor:'pointer', display:'flex', alignItems:'center', gap:'6px', fontSize:'13px', background: viewMode === 'overview' ? '#e2e8f0' : 'transparent', fontWeight: viewMode === 'overview' ? 700 : 500}}><LayoutDashboard size={14}/> Overview</div>
              <div onClick={()=>setViewMode('matrix')} style={{padding:'6px 12px', cursor:'pointer', display:'flex', alignItems:'center', gap:'6px', fontSize:'13px', background: viewMode === 'matrix' ? '#e2e8f0' : 'transparent', fontWeight: viewMode === 'matrix' ? 700 : 500}}><Grid size={14}/> Matrix Report</div>
           </div>
        </div>
        <div className="controls">
          <select className="control-input" value={account} onChange={(e) => setAccount(e.target.value)}><option value="cz">Czech 🇨🇿</option><option value="sk">Slovak 🇸🇰</option></select>
          <input type="date" className="control-input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          <span style={{ color: 'var(--text-secondary)' }}>to</span>
          <input type="date" className="control-input" value={dateTo} onChange={e => setDateTo(e.target.value)} />
          <input type="text" className="control-input" placeholder="Filter..." value={campaignFilter} onChange={e => setCampaignFilter(e.target.value)} style={{ width: '80px' }} />
          <button className="btn" onClick={() => setShowSettings(true)}><Settings size={16} /></button>
          <button className="btn" onClick={fetchData} disabled={loading} style={{ background: 'var(--text-primary)', color: '#fff' }}><RefreshCw size={16} className={loading ? 'spinner' : ''} /> {loading ? 'Fetching...' : 'Refresh'}</button>
        </div>
      </header>

      <main className="container">
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
            <div className="posts-grid">
              {posts.map(post => (
                <div key={post.id} className="post-card">
                  <div className="post-visual">
                    {apiKeys.supabaseUrl && (
                      <select className="tag-selector" value={tags[post.id] || ''} onChange={(e) => assignTag(post.id, e.target.value)}>
                        <option value="">⚙️ Uncategorized</option>
                        {categories.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    )}
                    <img src={post.imageUrl} alt="Creative"/>
                    <div className="post-network-icon" style={{ background: post.network === 'ig' ? 'linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)' : '#1877F2', width: 'auto', padding: '6px 12px', borderRadius: '20px', display: 'flex', alignItems: 'center', gap: '6px', top: '12px', right: '12px' }}>
                      <span style={{color: '#fff', fontSize: '11px', fontWeight: '700'}}>{post.network === 'ig' ? 'Instagram' : 'Facebook'}</span>
                    </div>
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
        ) : (
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
                            const sampleDate = posts.find(p => p.monthKey === mk)?.monthLabel || mk;
                            return <th key={mk} style={{minWidth: '320px'}}>{sampleDate}</th>
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {[...categories, ''].map(category => {
                         const rowPosts = posts.filter(p => category ? tags[p.id] === category : !tags[p.id]);
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
                                       <div key={p.id} className="matrix-mini-post">
                                          <div className="m-post-net" style={{background: p.network==='ig'?'linear-gradient(45deg, #f09433, #bc1888)':'#1877F2'}}>{p.network==='ig'?'IG':'FB'}</div>
                                          <img src={p.imageUrl} />
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
                            const monthPosts = posts.filter(p => p.monthKey === mk);
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
        )}
      </main>

      <footer style={{ textAlign: 'center', padding: '4rem 1rem', borderTop: '1px solid var(--border-color)', marginTop: 'auto', background: '#fff' }}>
         <div style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>Engineered by</div>
         <img src={`${import.meta.env.BASE_URL}opus-logo.png`} alt="Opus Magnus" style={{ height: '36px', filter: 'invert(1)', objectFit: 'contain' }} />
      </footer>
    </>
  );
};
export default App;
