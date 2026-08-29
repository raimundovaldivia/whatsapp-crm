import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Users, Search, RefreshCw, MessageSquare, ShoppingBag,
  TrendingUp, WifiOff, MapPin, ChevronRight, ChevronLeft, UserCheck, Zap, Upload, X, CheckCircle, AlertCircle,
} from 'lucide-react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  if (diff < 7)   return `Hace ${diff} días`;
  if (diff < 30)  return `Hace ${Math.floor(diff / 7)} sem.`;
  if (diff < 365) return `Hace ${Math.floor(diff / 30)} meses`;
  return `Hace ${Math.floor(diff / 365)} años`;
}

const PAGE_SIZE = 50;
const LEADS_PAGE_SIZE = 100;

export default function ClientesPanel({ onOpenConversation, onOpenReengagement }) {
  const { colors, isDark } = useTheme();

  // Tabs: 'clientes' = Shopify customers | 'leads' = WhatsApp leads from contacts DB
  const [tab, setTab] = useState('clientes');

  // ── Clientes (Shopify) state ──
  const [allCustomers, setAllCustomers] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [loadingProgress, setLoadingProgress] = useState({ loaded: 0, total: null });
  const [error, setError]               = useState(null);
  const [search, setSearch]             = useState('');
  const [page, setPage]                 = useState(1);
  const [expanded, setExpanded]         = useState(null);
  const [needsSync, setNeedsSync]       = useState(false);
  const [syncing, setSyncing]           = useState(false);
  const abortRef = useRef(false);
  // Edición de dirección inline
  const [addrEditId,  setAddrEditId]  = useState(null);
  const [addrStreet,  setAddrStreet]  = useState('');
  const [addrCity,    setAddrCity]    = useState('');
  const [addrSaving,  setAddrSaving]  = useState(false);
  const [addrErr,     setAddrErr]     = useState('');
  const startAddrEdit = (c) => {
    setAddrEditId(c.id);
    setAddrStreet(c.address?.address1 || '');
    setAddrCity(c.address?.city || '');
    setAddrErr('');
  };
  const cancelAddrEdit = () => { setAddrEditId(null); setAddrErr(''); };
  const saveAddr = async (c) => {
    if (!addrStreet.trim()) { setAddrErr('La dirección es requerida'); return; }
    setAddrSaving(true); setAddrErr('');
    try {
      await api.patch(`/contacts/${c.phone}`, { address: addrStreet.trim(), city: addrCity.trim() });
      // Actualizar localmente sin refetch completo
      setAllCustomers(prev => prev.map(x => x.id === c.id
        ? { ...x, address: { ...x.address, address1: addrStreet.trim(), city: addrCity.trim() } }
        : x
      ));
      setAddrEditId(null);
    } catch (e) {
      setAddrErr(e?.response?.data?.error || 'Error al guardar');
    } finally { setAddrSaving(false); }
  };

  // ── Leads (contacts DB) state ──
  const [leads, setLeads]           = useState([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadsError, setLeadsError] = useState(null);
  const [leadsSearch, setLeadsSearch] = useState('');
  const [leadsPage, setLeadsPage]   = useState(1);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [leadsStats, setLeadsStats] = useState(null);
  const [importModal, setImportModal] = useState(false);
  const [importRows, setImportRows]   = useState([]);   // [{phone, name, email}]
  const [importCols, setImportCols]   = useState({ phone: '', name: '', email: '' });
  const [importHeaders, setImportHeaders] = useState([]);
  const [importing, setImporting]     = useState(false);
  const [importResult, setImportResult] = useState(null);
  const fileInputRef = useRef(null);

  // ── Precios especiales ──
  const [priceModal, setPriceModal] = useState(null); // { phone, name }
  const [priceList, setPriceList]   = useState([]);
  const [priceLoading, setPriceLoading] = useState(false);
  const [availableProducts, setAvailableProducts] = useState([]);
  const [newPriceProductId, setNewPriceProductId]   = useState('');
  const [newPriceProductTitle, setNewPriceProductTitle] = useState('');
  const [newPriceValue, setNewPriceValue] = useState('');
  const [priceSaving, setPriceSaving] = useState(false);

  const openPriceModal = useCallback(async (contact) => {
    setPriceModal(contact);
    setPriceList([]);
    setNewPriceProductId('');
    setNewPriceProductTitle('');
    setNewPriceValue('');
    setPriceLoading(true);
    try {
      const [pricesRes, prodsRes] = await Promise.all([
        api.get(`/contacts/${contact.phone}/prices`),
        api.get('/products').catch(() => ({ data: { data: [] } })),
      ]);
      setPriceList(pricesRes.data.data || []);
      const prods = prodsRes.data?.data || prodsRes.data?.products || [];
      setAvailableProducts(prods);
    } catch (e) {
      console.error('Error cargando precios:', e);
    } finally {
      setPriceLoading(false);
    }
  }, []);

  const saveSpecialPrice = useCallback(async () => {
    if (!priceModal || !newPriceProductId || !newPriceValue) return;
    setPriceSaving(true);
    try {
      await api.put(`/contacts/${priceModal.phone}/prices`, {
        product_id: newPriceProductId,
        product_title: newPriceProductTitle,
        custom_price: parseFloat(String(newPriceValue).replace(/\./g, '').replace(',', '.')),
      });
      // Recargar lista
      const res = await api.get(`/contacts/${priceModal.phone}/prices`);
      setPriceList(res.data.data || []);
      setNewPriceProductId('');
      setNewPriceProductTitle('');
      setNewPriceValue('');
    } catch (e) {
      alert('Error guardando precio: ' + (e.response?.data?.error || e.message));
    } finally {
      setPriceSaving(false);
    }
  }, [priceModal, newPriceProductId, newPriceProductTitle, newPriceValue]);

  const deleteSpecialPrice = useCallback(async (productId) => {
    if (!priceModal) return;
    try {
      await api.delete(`/contacts/${priceModal.phone}/prices/${encodeURIComponent(productId)}`);
      setPriceList(prev => prev.filter(p => p.product_id !== productId));
    } catch (e) {
      alert('Error eliminando precio: ' + (e.response?.data?.error || e.message));
    }
  }, [priceModal]);

  // Una sola llamada al backend — el backend hace el loop internamente (servidor a servidor)
  const loadAll = useCallback(async () => {
    abortRef.current = false;
    setLoading(true);
    setError(null);
    setAllCustomers([]);
    setPage(1);
    setExpanded(null);
    setLoadingProgress({ loaded: 0, total: null });

    try {
      const res  = await api.get('/clientes/all', { timeout: 120000 });
      const data = res.data;
      if (!data.success) throw new Error(data.error);
      setAllCustomers(data.customers || []);
      setLoadingProgress({ loaded: data.total, total: data.total });
      setNeedsSync(!!data.needsSync);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLeads = useCallback(async (pageNum = 1, search = '') => {
    setLeadsLoading(true);
    setLeadsError(null);
    try {
      const [listRes, statsRes] = await Promise.all([
        api.get('/contacts', { params: { type: 'lead', search, page: pageNum, limit: LEADS_PAGE_SIZE } }),
        api.get('/contacts/stats'),
      ]);
      setLeads(listRes.data.contacts || []);
      setLeadsTotal(listRes.data.total || 0);
      setLeadsStats(statsRes.data);
    } catch (err) {
      setLeadsError(err.response?.data?.error || err.message);
    } finally {
      setLeadsLoading(false);
    }
  }, []);

  const syncShopify = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await api.post('/clientes/sync', {}, { timeout: 180000 });
      if (!res.data.success) throw new Error(res.data.error);
      // Backfill addresses from order history for contacts still missing address1
      await api.post('/contacts/backfill-shopify', {}, { timeout: 60000 }).catch(() => {});
      await loadAll();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSyncing(false);
    }
  }, [loadAll]);

  const handleImportFile = useCallback(async (file) => {
    if (!file) return;
    setImportResult(null);
    try {
      const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs');
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: 'array' });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
      if (data.length < 2) return;
      const headers = data[0].map(h => String(h || '').trim());
      const rows    = data.slice(1).map(r => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = String(r[i] ?? '').trim(); });
        return obj;
      }).filter(r => Object.values(r).some(v => v));
      setImportHeaders(headers);
      setImportRows(rows);
      // Auto-detectar columnas
      const phoneCol   = headers.find(h => /phone|tel[eé]|celular|m[oó]vil|whatsapp/i.test(h)) || headers[0];
      const nameCol    = headers.find(h => /nombre|name|t[ií]tulo/i.test(h)) || '';
      const emailCol   = headers.find(h => /email|correo/i.test(h)) || '';
      const addressCol = headers.find(h => /direcci[oó]n|address|domicilio/i.test(h)) || '';
      setImportCols({ phone: phoneCol, name: nameCol, email: emailCol, address: addressCol });
    } catch (e) {
      alert('Error leyendo el archivo: ' + e.message);
    }
  }, []);

  const submitImport = useCallback(async () => {
    if (!importCols.phone || importRows.length === 0) return;
    setImporting(true);
    setImportResult(null);
    try {
      const leads = importRows.map(r => {
        // Limpiar nombre: quitar prefijo tipo "#2973JACQUELINE" → "JACQUELINE"
        const rawName = importCols.name ? r[importCols.name] : '';
        const cleanName = rawName.replace(/^#\d+\s*/,'').trim();
        // Parsear dirección: "Calle 123, Depto, Ciudad, Región, Chile, 1700000"
        const rawAddr = importCols.address ? r[importCols.address] : '';
        let address = '', city = '';
        if (rawAddr) {
          const parts = rawAddr.split(',').map(p => p.trim()).filter(Boolean);
          // Eliminar Chile y códigos postales al final
          const filtered = parts.filter(p => !/^chile$/i.test(p) && !/^\d{5,}$/.test(p));
          // La primera parte es la calle, la penúltima (antes de región) es la ciudad
          address = filtered[0] || rawAddr;
          city = filtered.length >= 2 ? filtered[filtered.length - 2] : (filtered[1] || '');
        }
        return {
          phone:   r[importCols.phone] || '',
          name:    cleanName,
          email:   importCols.email ? r[importCols.email] : '',
          address,
          city,
        };
      }).filter(l => l.phone);
      const res = await api.post('/contacts/import', { leads });
      setImportResult(res.data);
      if (res.data.success) loadLeads(1, leadsSearch);
    } catch (e) {
      setImportResult({ success: false, error: e.response?.data?.error || e.message });
    } finally {
      setImporting(false);
    }
  }, [importRows, importCols, leadsSearch, loadLeads]);

  useEffect(() => { loadAll(); return () => { abortRef.current = true; }; }, []);

  // Load leads when switching to leads tab or searching
  useEffect(() => {
    if (tab === 'leads') loadLeads(leadsPage, leadsSearch);
  }, [tab, leadsPage]);

  // Reset leads page on search
  useEffect(() => {
    if (tab === 'leads') { setLeadsPage(1); loadLeads(1, leadsSearch); }
  }, [leadsSearch]);

  // Filtrado local por búsqueda
  const filtered = search.trim()
    ? allCustomers.filter(c => {
        const q = search.toLowerCase();
        return (
          c.name?.toLowerCase().includes(q) ||
          c.email?.toLowerCase().includes(q) ||
          c.phone?.includes(q) ||
          c.address?.city?.toLowerCase().includes(q)
        );
      })
    : allCustomers;

  // Paginación local
  const totalPages  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems   = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Reset página al buscar
  useEffect(() => { setPage(1); }, [search]);

  // Stats (sobre todos los cargados)
  const totalOrders = allCustomers.reduce((s, c) => s + (parseInt(c.ordersCount) || 0), 0);
  const totalSpent  = allCustomers.reduce((s, c) => s + (parseFloat(c.totalSpent)  || 0), 0);
  const withOrders  = allCustomers.filter(c => (parseInt(c.ordersCount) || 0) > 0).length;

  const isLeads = tab === 'leads';

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: colors.bgApp, overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '14px 24px', backgroundColor: colors.bgPanel, borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Users size={20} color={colors.green} />
          <h1 style={{ color: colors.textPrimary, fontSize: '17px', fontWeight: 600 }}>Clientes</h1>

          {/* Tab pills */}
          {[
            { key: 'clientes', label: 'Clientes Shopify', icon: <ShoppingBag size={12} /> },
            { key: 'leads',    label: 'Leads WhatsApp',   icon: <Zap size={12} /> },
          ].map(({ key, label, icon }) => (
            <button key={key} onClick={() => setTab(key)}
              style={{
                display: 'flex', alignItems: 'center', gap: '5px',
                padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600,
                border: `1px solid ${tab === key ? colors.green : colors.border}`,
                backgroundColor: tab === key ? `${colors.green}18` : 'transparent',
                color: tab === key ? colors.green : colors.textSecondary,
                cursor: 'pointer',
              }}>
              {icon} {label}
            </button>
          ))}

          {!isLeads && allCustomers.length > 0 && (
            <span style={{ backgroundColor: colors.bgHover, color: colors.textSecondary, borderRadius: '12px', padding: '2px 8px', fontSize: '12px' }}>
              {loading ? `${loadingProgress.loaded} cargando...` : `${allCustomers.length} total`}
            </span>
          )}
          {isLeads && leadsStats && (
            <span style={{ backgroundColor: colors.bgHover, color: colors.textSecondary, borderRadius: '12px', padding: '2px 8px', fontSize: '12px' }}>
              {leadsStats.leads} leads · {leadsStats.customers} clientes
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div style={{ backgroundColor: colors.bgHover, borderRadius: '8px', display: 'flex', alignItems: 'center', padding: '7px 12px', gap: '7px' }}>
            <Search size={14} color={colors.textSecondary} />
            <input
              type="text"
              placeholder={isLeads ? 'Buscar por nombre o teléfono...' : 'Buscar por nombre, email o teléfono...'}
              value={isLeads ? leadsSearch : search}
              onChange={e => isLeads ? setLeadsSearch(e.target.value) : setSearch(e.target.value)}
              style={{ background: 'none', border: 'none', color: colors.textPrimary, fontSize: '13px', outline: 'none', width: '220px' }}
            />
          </div>
          {isLeads && (
            <button onClick={() => { setImportModal(true); setImportRows([]); setImportResult(null); }} title="Importar leads desde archivo"
              style={{ padding: '6px 12px', borderRadius: '8px', backgroundColor: `${colors.green}18`, border: `1px solid ${colors.green}33`, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', color: colors.green, fontSize: '12px', fontWeight: 600 }}>
              <Upload size={12} /> Importar leads
            </button>
          )}
          {!isLeads && (
            <button onClick={syncShopify} disabled={syncing} title="Sincronizar clientes desde Shopify"
              style={{ padding: '6px 12px', borderRadius: '8px', backgroundColor: syncing ? colors.bgHover : `${colors.green}18`, border: `1px solid ${colors.green}33`, cursor: syncing ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '5px', color: colors.green, fontSize: '12px', fontWeight: 600 }}>
              <RefreshCw size={12} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
              {syncing ? 'Sincronizando...' : 'Sync Shopify'}
            </button>
          )}
          <button onClick={isLeads ? () => loadLeads(1, leadsSearch) : loadAll} title="Recargar desde DB local"
            style={{ padding: '8px', borderRadius: '8px', backgroundColor: colors.bgHover, border: 'none', cursor: 'pointer', display: 'flex' }}>
            <RefreshCw size={14} color={colors.textSecondary} />
          </button>
        </div>
      </div>

      {/* Stats — Clientes tab */}
      {!isLeads && allCustomers.length > 0 && (
        <div style={{ display: 'flex', backgroundColor: colors.bgApp, borderBottom: `1px solid ${colors.border}` }}>
          {[
            { label: 'Clientes totales', value: allCustomers.length,                                          icon: <Users size={14} /> },
            { label: 'Con pedidos',       value: withOrders,                                                  icon: <ShoppingBag size={14} /> },
            { label: 'Pedidos totales',   value: totalOrders.toLocaleString('es-CL'),                         icon: <ShoppingBag size={14} /> },
            { label: 'Ingresos totales',  value: `$${Math.round(totalSpent).toLocaleString('es-CL')}`,        icon: <TrendingUp size={14} /> },
          ].map(({ label, value, icon }) => (
            <div key={label} style={{ flex: 1, padding: '10px 20px', borderRight: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: colors.textSecondary }}>{icon}</span>
              <div>
                <div style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '15px' }}>{value}</div>
                <div style={{ color: colors.textSecondary, fontSize: '11px' }}>{label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Banner: primera vez, necesita sync */}
      {!isLeads && needsSync && !loading && (
        <div style={{ backgroundColor: `${colors.green}15`, borderBottom: `1px solid ${colors.green}33`, padding: '12px 24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <RefreshCw size={16} color={colors.green} />
          <span style={{ color: colors.textPrimary, fontSize: '13px' }}>
            Aún no hay clientes sincronizados. Hacé click en <strong>Sync Shopify</strong> para importar los clientes desde tu tienda.
          </span>
          <button onClick={syncShopify} disabled={syncing}
            style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: '8px', backgroundColor: colors.green, border: 'none', cursor: 'pointer', color: '#fff', fontSize: '12px', fontWeight: 700 }}>
            {syncing ? 'Sincronizando...' : 'Sincronizar ahora'}
          </button>
        </div>
      )}

      {/* Stats — Leads tab */}
      {isLeads && leadsStats && (
        <div style={{ display: 'flex', backgroundColor: colors.bgApp, borderBottom: `1px solid ${colors.border}` }}>
          {[
            { label: 'Total contactos', value: leadsStats.total || 0,     icon: <Users size={14} /> },
            { label: 'Leads',           value: leadsStats.leads || 0,     icon: <Zap size={14} /> },
            { label: 'Clientes',        value: leadsStats.customers || 0, icon: <ShoppingBag size={14} /> },
            { label: 'Conversión',      value: leadsStats.total ? `${Math.round((leadsStats.customers / leadsStats.total) * 100)}%` : '0%', icon: <TrendingUp size={14} /> },
          ].map(({ label, value, icon }) => (
            <div key={label} style={{ flex: 1, padding: '10px 20px', borderRight: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: colors.textSecondary }}>{icon}</span>
              <div>
                <div style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '15px' }}>{value}</div>
                <div style={{ color: colors.textSecondary, fontSize: '11px' }}>{label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ═══ CLIENTES TAB ═══ */}
      {!isLeads && (
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && allCustomers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px', color: colors.textSecondary }}>
            <div style={{ width: '36px', height: '36px', border: `3px solid ${colors.border}`, borderTop: `3px solid ${colors.green}`, borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
            <div style={{ fontSize: '14px', marginBottom: '6px' }}>Cargando clientes de Shopify...</div>
            <div style={{ fontSize: '12px', opacity: 0.6 }}>Puede tardar ~30s si Render está en cold start</div>
          </div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '60px', color: colors.red }}>
            <WifiOff size={40} style={{ marginBottom: '12px', opacity: 0.7 }} />
            <div style={{ fontSize: '14px', marginBottom: '16px', maxWidth: '400px', margin: '0 auto 16px', lineHeight: 1.5 }}>{error}</div>
            <button onClick={loadAll} style={{ backgroundColor: `${colors.green}22`, color: colors.green, border: `1px solid ${colors.green}33`, borderRadius: '8px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer' }}>
              Reintentar
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px', color: colors.textSecondary }}>
            <Users size={48} style={{ marginBottom: '16px', opacity: 0.2 }} />
            <div style={{ fontSize: '15px' }}>
              {search ? `Sin resultados para "${search}"` : 'No se encontraron clientes'}
            </div>
          </div>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ backgroundColor: colors.bgApp, position: 'sticky', top: 0, zIndex: 1 }}>
                  {['Cliente', 'Contacto', 'Pedidos', 'Total gastado', 'Último pedido', 'Ubicación', ''].map(h => (
                    <th key={h} style={{ padding: '10px 16px', textAlign: 'left', color: colors.textSecondary, fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageItems.map(c => (
                  <>
                    <tr
                      key={c.id}
                      onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                      style={{ borderBottom: `1px solid ${colors.bgSub}`, cursor: 'pointer', backgroundColor: expanded === c.id ? colors.bgAccent : 'transparent', transition: 'background-color 0.1s' }}
                      onMouseEnter={e => { if (expanded !== c.id) e.currentTarget.style.backgroundColor = colors.bgSub; }}
                      onMouseLeave={e => { if (expanded !== c.id) e.currentTarget.style.backgroundColor = 'transparent'; }}
                    >
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: colors.bgHover, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700, color: colors.green, flexShrink: 0 }}>
                            {(c.firstName?.[0] || c.name?.[0] || '?').toUpperCase()}
                          </div>
                          <div>
                            <div style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 500 }}>{c.name}</div>
                            {c.tags?.length > 0 && (
                              <div style={{ display: 'flex', gap: '3px', marginTop: '3px' }}>
                                {c.tags.slice(0, 2).map(t => (
                                  <span key={t} style={{ backgroundColor: colors.bgHover, color: colors.textSecondary, borderRadius: '4px', padding: '1px 5px', fontSize: '10px' }}>{t}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ fontSize: '12px', color: colors.textSecondary }}>
                          {c.email && <div style={{ marginBottom: '2px' }}>{c.email}</div>}
                          {c.phone && <div>{c.phone}</div>}
                          {!c.email && !c.phone && <span style={{ color: colors.borderStrong }}>—</span>}
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                        {(parseInt(c.ordersCount) || 0) > 0
                          ? <span style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center', color: colors.textPrimary, fontSize: '13px' }}>
                              <ShoppingBag size={12} color={colors.green} /> {parseInt(c.ordersCount)}
                            </span>
                          : <span style={{ color: colors.textSecondary, fontSize: '13px' }}>—</span>}
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        {(parseFloat(c.totalSpent) || 0) > 0
                          ? <span style={{ color: colors.green, fontSize: '13px', fontWeight: 600 }}>
                              ${Math.round(parseFloat(c.totalSpent)).toLocaleString('es-CL')} {c.currency}
                            </span>
                          : <span style={{ color: colors.textSecondary, fontSize: '13px' }}>—</span>}
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        {c.lastOrder ? (
                          <div>
                            <div style={{ color: colors.textPrimary, fontSize: '12px' }}>{c.lastOrder.name}</div>
                            <div style={{ color: colors.textSecondary, fontSize: '11px' }}>{formatDate(c.lastOrder.createdAt)}</div>
                          </div>
                        ) : <span style={{ color: colors.borderStrong, fontSize: '12px' }}>—</span>}
                      </td>
                      <td style={{ padding: '12px 16px', color: colors.textSecondary, fontSize: '12px' }}>
                        {(c.address?.city || c.address?.country)
                          ? <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <MapPin size={11} color={colors.green} />
                              {[c.address?.city, c.address?.province].filter(Boolean).join(', ')}
                            </span>
                          : '—'}
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                          {c.phone && onOpenConversation && (
                            <button onClick={e => { e.stopPropagation(); onOpenConversation(c.phone); }} title="Abrir chat"
                              style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: colors.bgHover, color: colors.textSecondary, padding: '5px 9px', borderRadius: '7px', fontSize: '11px', border: 'none', cursor: 'pointer' }}>
                              <MessageSquare size={11} /> Chat
                            </button>
                          )}
                          {c.phone && onOpenReengagement && (
                            <button onClick={e => { e.stopPropagation(); onOpenReengagement(c.phone); }} title="Re-enganchar"
                              style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: `${colors.green}18`, color: colors.green, padding: '5px 9px', borderRadius: '7px', fontSize: '11px', border: `1px solid ${colors.green}33`, cursor: 'pointer' }}>
                              <UserCheck size={11} /> Reenganche
                            </button>
                          )}
                          {c.phone && (
                            <button onClick={e => { e.stopPropagation(); openPriceModal({ phone: c.phone, name: c.name }); }} title="Precios especiales"
                              style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: `${'#f59e0b'}18`, color: '#f59e0b', padding: '5px 9px', borderRadius: '7px', fontSize: '11px', border: '1px solid #f59e0b33', cursor: 'pointer' }}>
                              💰 Precios
                            </button>
                          )}
                          <ChevronRight size={14} color={colors.borderStrong}
                            style={{ transform: expanded === c.id ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
                        </div>
                      </td>
                    </tr>
                    {expanded === c.id && (
                      <tr key={`${c.id}-detail`} style={{ backgroundColor: colors.bgApp }}>
                        <td colSpan={7} style={{ padding: '12px 16px 16px 62px', borderBottom: `2px solid ${colors.green}33` }}>
                          <div style={{ display: 'flex', gap: '32px', flexWrap: 'wrap' }}>
                            {c.lastOrder && (
                              <div>
                                <div style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Último pedido</div>
                                <div style={{ backgroundColor: colors.bgPanel, borderRadius: '8px', padding: '10px 14px', border: `1px solid ${colors.border}`, minWidth: '200px' }}>
                                  <div style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>{c.lastOrder.name}</div>
                                  {c.lastOrder.items?.length > 0 && (
                                    <div style={{ color: colors.textSecondary, fontSize: '12px', marginBottom: '4px' }}>{c.lastOrder.items.join(', ')}</div>
                                  )}
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ color: colors.green, fontSize: '13px', fontWeight: 600 }}>${Math.round(c.lastOrder.totalPrice).toLocaleString('es-CL')}</span>
                                    <span style={{ color: colors.textSecondary, fontSize: '11px' }}>{c.lastOrder.createdAt?.slice(0, 10)}</span>
                                  </div>
                                </div>
                              </div>
                            )}
                            <div>
                              <div style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Info</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '12px', color: colors.textSecondary }}>
                                <div><span style={{ color: colors.textPrimary }}>Cliente desde:</span> {formatDate(c.createdAt)}</div>
                                {c.phone && <div><span style={{ color: colors.textPrimary }}>Teléfono:</span> {c.phone}</div>}

                                {/* Dirección — editable */}
                                {addrEditId === c.id ? (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '4px' }}>
                                    <input value={addrStreet} onChange={e => setAddrStreet(e.target.value)} placeholder="Calle y número *"
                                      style={{ backgroundColor: colors.bgApp, color: colors.textPrimary, border: `1px solid ${addrStreet ? colors.border : '#f8717166'}`, borderRadius: '6px', padding: '5px 8px', fontSize: '12px' }} />
                                    <input value={addrCity} onChange={e => setAddrCity(e.target.value)} placeholder="Ciudad / Comuna"
                                      style={{ backgroundColor: colors.bgApp, color: colors.textPrimary, border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '5px 8px', fontSize: '12px' }} />
                                    {addrErr && <div style={{ color: '#f87171', fontSize: '11px' }}>{addrErr}</div>}
                                    <div style={{ display: 'flex', gap: '6px' }}>
                                      <button onClick={() => saveAddr(c)} disabled={addrSaving}
                                        style={{ padding: '4px 12px', borderRadius: '6px', border: 'none', backgroundColor: '#4ade80', color: '#000', fontSize: '11px', fontWeight: 600, cursor: addrSaving ? 'not-allowed' : 'pointer', opacity: addrSaving ? 0.7 : 1 }}>
                                        {addrSaving ? 'Guardando...' : '✓ Guardar'}
                                      </button>
                                      <button onClick={cancelAddrEdit}
                                        style={{ padding: '4px 10px', borderRadius: '6px', border: `1px solid ${colors.border}`, backgroundColor: 'transparent', color: colors.textSecondary, fontSize: '11px', cursor: 'pointer' }}>
                                        Cancelar
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    {c.address?.address1
                                      ? <div><span style={{ color: colors.textPrimary }}>Dirección:</span> {[c.address.address1, c.address.address2].filter(Boolean).join(', ')}</div>
                                      : <div style={{ color: '#f87171', fontStyle: 'italic' }}>⚠ Sin dirección de calle</div>
                                    }
                                    {c.address?.city && <div><span style={{ color: colors.textPrimary }}>Ciudad:</span> {c.address.city}{c.address.province ? `, ${c.address.province}` : ''}</div>}
                                    {c.address?.zip  && <div><span style={{ color: colors.textPrimary }}>CP:</span> {c.address.zip}</div>}
                                    <button onClick={() => startAddrEdit(c)}
                                      style={{ alignSelf: 'flex-start', marginTop: '2px', padding: '3px 10px', borderRadius: '6px', border: `1px solid ${colors.border}`, backgroundColor: 'transparent', color: colors.textSecondary, fontSize: '11px', cursor: 'pointer' }}>
                                      ✏️ {c.address?.address1 ? 'Editar dirección' : 'Agregar dirección'}
                                    </button>
                                  </>
                                )}

                                {c.address?.country && <div><span style={{ color: colors.textPrimary }}>País:</span> {c.address.country}</div>}
                                {c.note             && <div><span style={{ color: colors.textPrimary }}>Nota:</span> {c.note}</div>}
                                {c.tags?.length > 0 && (
                                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
                                    <span style={{ color: colors.textPrimary }}>Tags:</span>
                                    {c.tags.map(t => (
                                      <span key={t} style={{ backgroundColor: colors.bgHover, color: colors.textSecondary, borderRadius: '4px', padding: '1px 6px', fontSize: '11px' }}>{t}</span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>

            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '16px', borderTop: `1px solid ${colors.border}` }}>
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={currentPage <= 1}
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: currentPage <= 1 ? colors.bgSub : colors.bgHover, color: currentPage <= 1 ? colors.borderStrong : colors.textSecondary, border: 'none', borderRadius: '7px', padding: '7px 12px', fontSize: '12px', cursor: currentPage <= 1 ? 'default' : 'pointer' }}>
                  <ChevronLeft size={14} /> Anterior
                </button>
                <span style={{ color: colors.textSecondary, fontSize: '13px' }}>
                  Página <strong style={{ color: colors.textPrimary }}>{currentPage}</strong> de <strong style={{ color: colors.textPrimary }}>{totalPages}</strong>
                  <span style={{ marginLeft: '8px', color: colors.borderStrong, fontSize: '11px' }}>({filtered.length} clientes{search ? ' encontrados' : ''})</span>
                </span>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages}
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: currentPage >= totalPages ? colors.bgSub : colors.bgHover, color: currentPage >= totalPages ? colors.borderStrong : colors.textSecondary, border: 'none', borderRadius: '7px', padding: '7px 12px', fontSize: '12px', cursor: currentPage >= totalPages ? 'default' : 'pointer' }}>
                  Siguiente <ChevronRight size={14} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
      )}

      {/* ═══ LEADS TAB ═══ */}
      {isLeads && (
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {leadsLoading ? (
          <div style={{ textAlign: 'center', padding: '80px', color: colors.textSecondary }}>
            <div style={{ width: '36px', height: '36px', border: `3px solid ${colors.border}`, borderTop: `3px solid ${colors.green}`, borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
            <div style={{ fontSize: '14px' }}>Cargando leads...</div>
          </div>
        ) : leadsError ? (
          <div style={{ textAlign: 'center', padding: '60px', color: colors.red }}>
            <WifiOff size={40} style={{ marginBottom: '12px', opacity: 0.7 }} />
            <div style={{ fontSize: '14px', marginBottom: '16px' }}>{leadsError}</div>
            <button onClick={() => loadLeads(1, leadsSearch)} style={{ backgroundColor: `${colors.green}22`, color: colors.green, border: `1px solid ${colors.green}33`, borderRadius: '8px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer' }}>Reintentar</button>
          </div>
        ) : leads.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px', color: colors.textSecondary }}>
            <Zap size={48} style={{ marginBottom: '16px', opacity: 0.2 }} />
            <div style={{ fontSize: '15px' }}>{leadsSearch ? `Sin resultados para "${leadsSearch}"` : 'Aún no hay leads. Los contactos aparecerán aquí cuando alguien escriba por WhatsApp.'}</div>
          </div>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ backgroundColor: colors.bgApp, position: 'sticky', top: 0, zIndex: 1 }}>
                  {['Contacto', 'Teléfono', 'Dirección', 'Último mensaje', 'Pedidos', 'Tipo', ''].map(h => (
                    <th key={h} style={{ padding: '10px 16px', textAlign: 'left', color: colors.textSecondary, fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {leads.map(lead => (
                  <tr key={lead.phone}
                    style={{ borderBottom: `1px solid ${colors.bgSub}`, transition: 'background-color 0.1s' }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = colors.bgSub}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: colors.bgHover, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700, color: lead.contact_type === 'customer' ? colors.green : '#fb923c', flexShrink: 0 }}>
                          {(lead.display_name || lead.name || lead.phone || '?')[0].toUpperCase()}
                        </div>
                        <div style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 500 }}>
                          {lead.display_name || lead.name || 'Sin nombre'}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', color: colors.textSecondary, fontSize: '12px' }}>{lead.phone}</td>
                    <td style={{ padding: '12px 16px', color: colors.textSecondary, fontSize: '12px' }}>
                      {(lead.address || lead.city)
                        ? <span style={{ display: 'flex', alignItems: 'flex-start', gap: '4px' }}>
                            <MapPin size={11} style={{ marginTop: '1px', flexShrink: 0, color: colors.green }} />
                            <span>{[lead.address, lead.city].filter(Boolean).join(', ')}</span>
                          </span>
                        : '—'}
                    </td>
                    <td style={{ padding: '12px 16px', color: colors.textSecondary, fontSize: '12px' }}>{lead.last_seen_at ? formatDate(lead.last_seen_at) : '—'}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                      {(parseInt(lead.total_orders) || 0) > 0
                        ? <span style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center', color: colors.textPrimary, fontSize: '13px' }}>
                            <ShoppingBag size={12} color={colors.green} /> {parseInt(lead.total_orders)}
                          </span>
                        : <span style={{ color: colors.textSecondary, fontSize: '13px' }}>—</span>}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      {lead.contact_type === 'customer'
                        ? <span style={{ backgroundColor: `${colors.green}18`, color: colors.green, border: `1px solid ${colors.green}33`, borderRadius: '12px', padding: '2px 8px', fontSize: '11px', fontWeight: 600 }}>Cliente</span>
                        : <span style={{ backgroundColor: '#fb923c18', color: '#fb923c', border: '1px solid #fb923c33', borderRadius: '12px', padding: '2px 8px', fontSize: '11px', fontWeight: 600 }}>Lead</span>}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', gap: '5px' }}>
                        {onOpenConversation && (
                          <button onClick={() => onOpenConversation(lead.phone)} title="Abrir chat"
                            style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: colors.bgHover, color: colors.textSecondary, padding: '5px 9px', borderRadius: '7px', fontSize: '11px', border: 'none', cursor: 'pointer' }}>
                            <MessageSquare size={11} /> Chat
                          </button>
                        )}
                        {onOpenReengagement && (
                          <button onClick={() => onOpenReengagement(lead.phone)} title="Re-enganchar"
                            style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: `${colors.green}18`, color: colors.green, padding: '5px 9px', borderRadius: '7px', fontSize: '11px', border: `1px solid ${colors.green}33`, cursor: 'pointer' }}>
                            <UserCheck size={11} /> Reenganche
                          </button>
                        )}
                        <button onClick={() => openPriceModal({ phone: lead.phone, name: lead.display_name || lead.name || lead.phone })} title="Precios especiales"
                          style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: '#f59e0b18', color: '#f59e0b', padding: '5px 9px', borderRadius: '7px', fontSize: '11px', border: '1px solid #f59e0b33', cursor: 'pointer' }}>
                          💰
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Leads pagination */}
            {leadsTotal > LEADS_PAGE_SIZE && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '16px', borderTop: `1px solid ${colors.border}` }}>
                <button onClick={() => setLeadsPage(p => Math.max(1, p - 1))} disabled={leadsPage <= 1}
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: leadsPage <= 1 ? colors.bgSub : colors.bgHover, color: leadsPage <= 1 ? colors.borderStrong : colors.textSecondary, border: 'none', borderRadius: '7px', padding: '7px 12px', fontSize: '12px', cursor: leadsPage <= 1 ? 'default' : 'pointer' }}>
                  <ChevronLeft size={14} /> Anterior
                </button>
                <span style={{ color: colors.textSecondary, fontSize: '13px' }}>
                  Página <strong style={{ color: colors.textPrimary }}>{leadsPage}</strong>
                  <span style={{ marginLeft: '8px', color: colors.borderStrong, fontSize: '11px' }}>({leadsTotal} total)</span>
                </span>
                <button onClick={() => setLeadsPage(p => p + 1)} disabled={leadsPage * LEADS_PAGE_SIZE >= leadsTotal}
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: leadsPage * LEADS_PAGE_SIZE >= leadsTotal ? colors.bgSub : colors.bgHover, color: leadsPage * LEADS_PAGE_SIZE >= leadsTotal ? colors.borderStrong : colors.textSecondary, border: 'none', borderRadius: '7px', padding: '7px 12px', fontSize: '12px', cursor: leadsPage * LEADS_PAGE_SIZE >= leadsTotal ? 'default' : 'pointer' }}>
                  Siguiente <ChevronRight size={14} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {/* Modal precios especiales */}
      {priceModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ backgroundColor: colors.bgPanel, borderRadius: '14px', border: `1px solid ${colors.border}`, width: '500px', maxWidth: '95vw', maxHeight: '85vh', overflow: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ color: colors.textPrimary, fontSize: '16px', fontWeight: 700 }}>💰 Precios especiales</div>
                <div style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '2px' }}>{priceModal.name} · {priceModal.phone}</div>
              </div>
              <button onClick={() => setPriceModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary }}>
                <X size={18} />
              </button>
            </div>

            {/* Lista de precios actuales */}
            {priceLoading ? (
              <div style={{ textAlign: 'center', padding: '24px', color: colors.textSecondary, fontSize: '13px' }}>Cargando...</div>
            ) : priceList.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '16px', color: colors.textSecondary, fontSize: '13px' }}>Sin precios especiales configurados</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {priceList.map(p => (
                  <div key={p.product_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.bgApp, borderRadius: '8px', padding: '8px 12px', border: `1px solid ${colors.border}` }}>
                    <div>
                      <div style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 500 }}>{p.product_title || p.product_id}</div>
                      <div style={{ color: '#f59e0b', fontSize: '14px', fontWeight: 700 }}>${Number(p.custom_price).toLocaleString('es-CL')}</div>
                    </div>
                    <button onClick={() => deleteSpecialPrice(p.product_id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: '18px', lineHeight: 1 }}>×</button>
                  </div>
                ))}
              </div>
            )}

            {/* Agregar precio */}
            <div style={{ borderTop: `1px solid ${colors.border}`, paddingTop: '14px' }}>
              <div style={{ color: colors.textSecondary, fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', marginBottom: '8px' }}>Agregar / actualizar precio</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {/* Selector de producto */}
                {availableProducts.length > 0 ? (
                  <select
                    value={newPriceProductId}
                    onChange={e => {
                      const opt = e.target.options[e.target.selectedIndex];
                      setNewPriceProductId(e.target.value);
                      setNewPriceProductTitle(opt.text);
                    }}
                    style={{ padding: '7px 10px', borderRadius: '7px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgApp, color: colors.textPrimary, fontSize: '13px' }}>
                    <option value="">— Seleccionar producto —</option>
                    {availableProducts.map(p => (
                      <option key={p.id || p.external_id} value={String(p.id || p.external_id)}>{p.title || p.name}</option>
                    ))}
                  </select>
                ) : (
                  <input value={newPriceProductTitle} onChange={e => { setNewPriceProductTitle(e.target.value); setNewPriceProductId(e.target.value); }}
                    placeholder="Nombre del producto"
                    style={{ padding: '7px 10px', borderRadius: '7px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgApp, color: colors.textPrimary, fontSize: '13px' }} />
                )}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    value={newPriceValue}
                    onChange={e => setNewPriceValue(e.target.value)}
                    placeholder="Precio especial (ej: 9500)"
                    type="number"
                    min="0"
                    style={{ flex: 1, padding: '7px 10px', borderRadius: '7px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgApp, color: colors.textPrimary, fontSize: '13px' }} />
                  <button onClick={saveSpecialPrice} disabled={priceSaving || !newPriceProductId || !newPriceValue}
                    style={{ padding: '7px 18px', borderRadius: '7px', backgroundColor: '#f59e0b', border: 'none', color: '#000', fontSize: '13px', fontWeight: 700, cursor: priceSaving || !newPriceProductId || !newPriceValue ? 'not-allowed' : 'pointer', opacity: priceSaving || !newPriceProductId || !newPriceValue ? 0.5 : 1 }}>
                    {priceSaving ? '...' : 'Guardar'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal importar leads */}
      {importModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ backgroundColor: colors.bgPanel, borderRadius: '14px', border: `1px solid ${colors.border}`, width: '540px', maxWidth: '95vw', maxHeight: '85vh', overflow: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Upload size={18} color={colors.green} />
                <span style={{ color: colors.textPrimary, fontSize: '16px', fontWeight: 700 }}>Importar leads</span>
              </div>
              <button onClick={() => setImportModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary }}>
                <X size={18} />
              </button>
            </div>

            {/* Upload area */}
            {importRows.length === 0 && !importResult && (
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); handleImportFile(e.dataTransfer.files[0]); }}
                style={{ border: `2px dashed ${colors.green}44`, borderRadius: '10px', padding: '32px', textAlign: 'center', cursor: 'pointer', color: colors.textSecondary, fontSize: '13px' }}>
                <Upload size={28} color={colors.green} style={{ marginBottom: '8px' }} />
                <div style={{ color: colors.textPrimary, fontWeight: 600, marginBottom: '4px' }}>Arrastrá tu archivo aquí o hacé click</div>
                <div>CSV o Excel (.xlsx) — una columna debe ser el teléfono</div>
                <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }}
                  onChange={e => handleImportFile(e.target.files[0])} />
              </div>
            )}

            {/* Columnas y preview */}
            {importRows.length > 0 && !importResult && (
              <>
                <div style={{ color: colors.textSecondary, fontSize: '12px' }}>
                  <strong style={{ color: colors.textPrimary }}>{importRows.length}</strong> filas detectadas. Asigná qué columna es cada campo:
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  {[
                    { key: 'phone',   label: 'Teléfono *',  required: true },
                    { key: 'name',    label: 'Nombre',       required: false },
                    { key: 'address', label: 'Dirección',    required: false },
                    { key: 'email',   label: 'Email',        required: false },
                  ].map(({ key, label, required }) => (
                    <div key={key}>
                      <div style={{ color: colors.textSecondary, fontSize: '11px', marginBottom: '4px' }}>{label}</div>
                      <select
                        value={importCols[key]}
                        onChange={e => setImportCols(p => ({ ...p, [key]: e.target.value }))}
                        style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: `1px solid ${required && !importCols[key] ? colors.red || '#ef4444' : colors.border}`, backgroundColor: colors.bgApp, color: colors.textPrimary, fontSize: '12px' }}>
                        <option value="">— ninguna —</option>
                        {importHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  ))}
                </div>

                {/* Preview */}
                <div style={{ backgroundColor: colors.bgApp, borderRadius: '8px', overflow: 'auto', maxHeight: '180px', fontSize: '12px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        {['Teléfono', 'Nombre', 'Dirección', 'Email'].map(h => (
                          <th key={h} style={{ padding: '6px 10px', color: colors.textSecondary, textAlign: 'left', borderBottom: `1px solid ${colors.border}` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {importRows.slice(0, 6).map((r, i) => (
                        <tr key={i}>
                          <td style={{ padding: '5px 10px', color: colors.textPrimary }}>{importCols.phone   ? r[importCols.phone]   : '—'}</td>
                          <td style={{ padding: '5px 10px', color: colors.textSecondary }}>{importCols.name    ? r[importCols.name]?.replace(/^#\d+\s*/,'') : '—'}</td>
                          <td style={{ padding: '5px 10px', color: colors.textSecondary }}>{importCols.address ? r[importCols.address] : '—'}</td>
                          <td style={{ padding: '5px 10px', color: colors.textSecondary }}>{importCols.email   ? r[importCols.email]   : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {importRows.length > 6 && <div style={{ padding: '5px 10px', color: colors.textSecondary }}>... y {importRows.length - 6} más</div>}
                </div>

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                  <button onClick={() => setImportRows([])} style={{ padding: '8px 14px', borderRadius: '8px', backgroundColor: colors.bgHover, border: `1px solid ${colors.border}`, color: colors.textSecondary, fontSize: '13px', cursor: 'pointer' }}>
                    Cambiar archivo
                  </button>
                  <button onClick={submitImport} disabled={importing || !importCols.phone}
                    style={{ padding: '8px 18px', borderRadius: '8px', backgroundColor: colors.green, border: 'none', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: importing || !importCols.phone ? 'not-allowed' : 'pointer', opacity: importing || !importCols.phone ? 0.7 : 1 }}>
                    {importing ? 'Importando...' : `Importar ${importRows.length} leads`}
                  </button>
                </div>
              </>
            )}

            {/* Resultado */}
            {importResult && (
              <div style={{ textAlign: 'center', padding: '16px' }}>
                {importResult.success
                  ? <CheckCircle size={40} color={colors.green} style={{ marginBottom: '12px' }} />
                  : <AlertCircle size={40} color="#ef4444" style={{ marginBottom: '12px' }} />}
                {importResult.success ? (
                  <>
                    <div style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '16px', marginBottom: '12px' }}>Importación completada</div>
                    <div style={{ display: 'flex', justifyContent: 'center', gap: '16px', fontSize: '13px', flexWrap: 'wrap' }}>
                      <div><span style={{ color: colors.green, fontWeight: 700, fontSize: '22px' }}>{importResult.imported}</span><br /><span style={{ color: colors.textSecondary }}>Nuevos leads</span></div>
                      <div><span style={{ color: colors.textSecondary, fontWeight: 700, fontSize: '22px' }}>{importResult.existingLeads ?? importResult.skipped ?? 0}</span><br /><span style={{ color: colors.textSecondary }}>Ya eran leads</span></div>
                      <div><span style={{ color: '#3b82f6', fontWeight: 700, fontSize: '22px' }}>{importResult.existingCustomers ?? 0}</span><br /><span style={{ color: colors.textSecondary }}>Ya son clientes</span></div>
                      <div><span style={{ color: '#f59e0b', fontWeight: 700, fontSize: '22px' }}>{importResult.invalid}</span><br /><span style={{ color: colors.textSecondary }}>Sin tel. válido</span></div>
                    </div>
                    {(importResult.existingCustomers > 0) && (
                      <div style={{ marginTop: '10px', fontSize: '12px', color: colors.textSecondary, padding: '8px', backgroundColor: colors.bgApp, borderRadius: '6px' }}>
                        💡 {importResult.existingCustomers} ya existen como clientes — sus datos de dirección fueron actualizados. Están en la pestaña <strong>Clientes</strong>.
                      </div>
                    )}
                    {importResult.errors?.length > 0 && (
                      <div style={{ marginTop: '8px', fontSize: '11px', color: '#ef4444' }}>
                        Errores: {importResult.errors.map(e => `${e.phone}: ${e.error}`).join(' · ')}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ color: '#ef4444', fontSize: '14px' }}>{importResult.error}</div>
                )}
                <button onClick={() => setImportModal(false)} style={{ marginTop: '16px', padding: '8px 20px', borderRadius: '8px', backgroundColor: colors.green, border: 'none', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>
                  Cerrar
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
