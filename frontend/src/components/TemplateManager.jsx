/**
 * TemplateManager — Gestor de WhatsApp Message Templates
 *
 * Permite crear, ver y eliminar templates de WhatsApp Business.
 * Los templates deben ser aprobados por Meta antes de poder usarse.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  FileText, Plus, Trash2, RefreshCw, CheckCircle,
  Clock, XCircle, Loader, AlertCircle, ChevronDown, ChevronUp,
  Info, Sparkles, Wand2, Zap, Send, ToggleLeft, ToggleRight,
} from 'lucide-react';
import { templatesAPI, reengagementAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';

const LANGUAGES = [
  { value: 'es',    label: 'Español (es)' },
  { value: 'es_MX', label: 'Español México (es_MX)' },
  { value: 'es_AR', label: 'Español Argentina (es_AR)' },
  { value: 'en_US', label: 'English US (en_US)' },
  { value: 'en_GB', label: 'English UK (en_GB)' },
  { value: 'pt_BR', label: 'Português BR (pt_BR)' },
];

const CATEGORIES = [
  { value: 'MARKETING',       label: 'Marketing',       desc: 'Promociones, ofertas, re-enganche de clientes' },
  { value: 'UTILITY',         label: 'Utilidad',        desc: 'Confirmaciones de pedido, actualizaciones de estado' },
  { value: 'AUTHENTICATION',  label: 'Autenticación',   desc: 'Códigos de verificación, contraseñas' },
];

function getStatusConfig(colors) {
  return {
    APPROVED: { color: colors.greenLight, bg: colors.greenTint, icon: CheckCircle, label: 'Aprobado' },
    PENDING:  { color: colors.yellow,     bg: '#2e2100',        icon: Clock,        label: 'Pendiente' },
    REJECTED: { color: colors.red,        bg: '#3a1a1a',        icon: XCircle,      label: 'Rechazado' },
  };
}

function StatusBadge({ status, colors }) {
  const cfg = getStatusConfig(colors)[status] || getStatusConfig(colors).PENDING;
  const Icon = cfg.icon;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      backgroundColor: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.color}44`,
      borderRadius: '6px', padding: '3px 8px', fontSize: '11px', fontWeight: 700,
    }}>
      <Icon size={11} /> {cfg.label}
    </span>
  );
}

function TemplateCard({ template, onDelete, deleting, colors }) {
  const [expanded, setExpanded] = useState(false);
  const bodyComp   = template.components?.find(c => c.type === 'BODY');
  const headerComp = template.components?.find(c => c.type === 'HEADER');
  const footerComp = template.components?.find(c => c.type === 'FOOTER');

  const vars = bodyComp?.text
    ? [...new Set([...bodyComp.text.matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1]))]
    : [];

  return (
    <div style={{
      backgroundColor: colors.bgSub,
      border: `1px solid ${colors.border}`,
      borderRadius: '10px',
      overflow: 'hidden',
      transition: 'border-color 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px' }}>
        <FileText size={15} color={colors.textSecondary} style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '14px', fontFamily: 'monospace' }}>
              {template.name}
            </span>
            <StatusBadge status={template.status} colors={colors} />
          </div>
          <div style={{ color: colors.textSecondary, fontSize: '11px', marginTop: '2px' }}>
            {template.language} · {template.category}
            {vars.length > 0 && <span style={{ color: colors.green }}> · {vars.length} variable{vars.length !== 1 ? 's' : ''}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
          <button
            onClick={() => setExpanded(p => !p)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, padding: '4px', display: 'flex' }}>
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button
            onClick={() => onDelete(template.name)}
            disabled={deleting === template.name}
            title="Eliminar template"
            style={{
              background: 'none', border: `1px solid ${colors.borderStrong}`, borderRadius: '5px',
              cursor: deleting === template.name ? 'not-allowed' : 'pointer',
              color: deleting === template.name ? colors.textMuted : colors.red,
              padding: '4px 6px', display: 'flex', alignItems: 'center',
            }}>
            {deleting === template.name
              ? <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} />
              : <Trash2 size={12} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${colors.border}` }}>
          <div style={{ marginTop: '10px', backgroundColor: colors.bgApp, borderRadius: '8px', padding: '10px 12px' }}>
            {headerComp?.text && (
              <div style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '13px', marginBottom: '6px' }}>
                {headerComp.text}
              </div>
            )}
            <div style={{ color: colors.textPrimary, fontSize: '13px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {bodyComp?.text || '(sin cuerpo)'}
            </div>
            {footerComp?.text && (
              <div style={{ color: colors.textSecondary, fontSize: '11px', marginTop: '6px' }}>
                {footerComp.text}
              </div>
            )}
          </div>
          {template.status === 'REJECTED' && template.rejectedReason && (
            <div style={{ marginTop: '8px', backgroundColor: '#3a1a1a', borderRadius: '6px', padding: '8px 10px', fontSize: '11px', color: colors.red }}>
              <strong>Motivo del rechazo:</strong> {template.rejectedReason}
            </div>
          )}
          {template.status === 'PENDING' && (
            <div style={{ marginTop: '8px', color: colors.yellow, fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Clock size={11} /> Meta está revisando este template. Normalmente tarda entre 1 y 24 horas.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   BulkGenerateTab — genera varios templates del catálogo Shopify de un solo click
───────────────────────────────────────────────────────────────────────── */
function BulkGenerateTab({ onSubmitted, colors }) {
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cards, setCards]           = useState([]);       // templates generados editables
  const [selected, setSelected]     = useState({});       // { index: bool }
  const [results, setResults]       = useState([]);       // resultados del submit
  const [error, setError]           = useState('');

  const inputStyle = {
    width: '100%', backgroundColor: colors.bgApp, color: colors.textPrimary,
    border: `1px solid ${colors.borderStrong}`, borderRadius: '8px',
    padding: '9px 12px', fontSize: '13px', outline: 'none',
    boxSizing: 'border-box', fontFamily: 'inherit',
  };

  const handleGenerate = async () => {
    setGenerating(true); setError(''); setCards([]); setSelected({}); setResults([]);
    try {
      const res = await reengagementAPI.generateBulkTemplates();
      const templates = res.templates || res.data?.templates || [];
      if (!templates.length) { setError('No se pudieron generar templates. Verifica que Shopify esté conectado.'); return; }
      setCards(templates);
      // Seleccionar todos por defecto
      const sel = {};
      templates.forEach((_, i) => { sel[i] = true; });
      setSelected(sel);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Error generando templates');
    } finally {
      setGenerating(false);
    }
  };

  const toggleCard = (i) => setSelected(prev => ({ ...prev, [i]: !prev[i] }));

  const updateCard = (i, field, value) =>
    setCards(prev => prev.map((c, idx) => idx === i ? { ...c, [field]: value } : c));

  const handleSubmitAll = async () => {
    const toSend = cards.filter((_, i) => selected[i]);
    if (!toSend.length) { setError('Selecciona al menos un template'); return; }
    setSubmitting(true); setError(''); setResults([]);
    try {
      const res = await reengagementAPI.submitTemplates(toSend);
      setResults(res.results || []);
      const anyOk = (res.results || []).some(r => r.success);
      if (anyOk) onSubmitted?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Error enviando templates a Meta');
    } finally {
      setSubmitting(false);
    }
  };

  const selectedCount = Object.values(selected).filter(Boolean).length;

  // ── Estado vacío ────────────────────────────────────────────────────────
  if (!cards.length && !results.length) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {/* Hero */}
        <div style={{
          background: `linear-gradient(135deg, ${colors.bgSub} 0%, ${colors.bgAccent2} 100%)`,
          border: `1px solid ${colors.purple}33`,
          borderRadius: '14px', padding: '24px',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '40px', marginBottom: '10px' }}>✨</div>
          <h3 style={{ color: colors.textPrimary, fontSize: '16px', fontWeight: 700, margin: '0 0 8px' }}>
            Genera varios templates de un solo click
          </h3>
          <p style={{ color: colors.textSecondary, fontSize: '13px', lineHeight: 1.6, margin: '0 0 20px' }}>
            La IA analiza tu catálogo de Shopify y crea <strong style={{ color: colors.purple }}>5 templates</strong> listos
            para Meta — distintos enfoques: re-enganche, oferta, recordatorio, nuevos productos y más.
            Puedes editarlos antes de enviarlos.
          </p>
          <button
            onClick={handleGenerate}
            disabled={generating}
            style={{
              backgroundColor: generating ? colors.bgHover : colors.purple,
              color: generating ? colors.textSecondary : 'white',
              border: 'none', borderRadius: '10px',
              padding: '13px 28px', fontSize: '15px', fontWeight: 700,
              cursor: generating ? 'not-allowed' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              transition: 'all 0.15s',
            }}>
            {generating
              ? <><Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Analizando catálogo...</>
              : <><Zap size={16} /> Generar 5 templates con IA</>}
          </button>
          {generating && (
            <p style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '12px' }}>
              Esto puede tardar 15-30 segundos mientras la IA lee tu catálogo Shopify...
            </p>
          )}
        </div>

        {error && (
          <div style={{ backgroundColor: '#3a1a1a', border: `1px solid ${colors.red}44`, borderRadius: '8px', padding: '12px 14px', color: colors.red, fontSize: '13px', display: 'flex', gap: '8px' }}>
            <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px' }} /> {error}
          </div>
        )}

        {/* Info */}
        <div style={{ backgroundColor: colors.bgSub, borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: colors.textSecondary, lineHeight: 1.7, display: 'flex', gap: '8px' }}>
          <Info size={14} color="#4db6e8" style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>
            Los templates generados estarán en estado <strong style={{ color: colors.yellow }}>Pendiente</strong> hasta
            que Meta los apruebe (1–24 h). Una vez <strong style={{ color: colors.greenLight }}>Aprobados</strong>,
            aparecerán disponibles en la sección Re-enganche para enviarlos a tus clientes.
          </span>
        </div>

        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ── Resultados post-submit ───────────────────────────────────────────────
  if (results.length) {
    const ok  = results.filter(r => r.success);
    const bad = results.filter(r => !r.success);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ backgroundColor: ok.length ? colors.greenTint : '#3a1a1a', border: `1px solid ${ok.length ? colors.green : colors.red}44`, borderRadius: '10px', padding: '16px', textAlign: 'center' }}>
          <div style={{ fontSize: '32px', marginBottom: '8px' }}>{ok.length ? '🎉' : '⚠️'}</div>
          <div style={{ color: colors.textPrimary, fontSize: '15px', fontWeight: 700, marginBottom: '4px' }}>
            {ok.length}/{results.length} templates enviados a Meta
          </div>
          <div style={{ color: colors.textSecondary, fontSize: '12px' }}>
            {ok.length > 0 && `${ok.length} en revisión — Meta los aprueba en 1-24 horas.`}
            {bad.length > 0 && ` ${bad.length} fallaron.`}
          </div>
        </div>

        {results.map((r, i) => (
          <div key={i} style={{
            backgroundColor: colors.bgSub, borderRadius: '8px', padding: '10px 14px',
            border: `1px solid ${r.success ? colors.green : colors.red}44`,
            display: 'flex', alignItems: 'center', gap: '10px',
          }}>
            {r.success
              ? <CheckCircle size={15} color={colors.greenLight} />
              : <XCircle size={15} color={colors.red} />}
            <div style={{ flex: 1 }}>
              <span style={{ color: colors.textPrimary, fontWeight: 600, fontSize: '13px', fontFamily: 'monospace' }}>{r.name}</span>
              {!r.success && r.error && (
                <div style={{ color: colors.red, fontSize: '11px', marginTop: '2px' }}>{r.error}</div>
              )}
              {r.success && (
                <div style={{ color: colors.textSecondary, fontSize: '11px', marginTop: '2px' }}>Pendiente de revisión por Meta</div>
              )}
            </div>
          </div>
        ))}

        <button
          onClick={() => { setCards([]); setResults([]); setSelected({}); }}
          style={{
            backgroundColor: colors.bgHover, color: colors.textSecondary,
            border: `1px solid ${colors.border}`, borderRadius: '8px',
            padding: '10px', fontSize: '13px', cursor: 'pointer',
          }}>
          ← Generar más templates
        </button>

        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ── Cards editables ──────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Header con acciones */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        backgroundColor: colors.bgSub, borderRadius: '10px', padding: '12px 16px',
        border: `1px solid ${colors.purple}44`,
      }}>
        <div>
          <span style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '14px' }}>
            ✨ {cards.length} templates generados desde tu catálogo
          </span>
          <div style={{ color: colors.textSecondary, fontSize: '11px', marginTop: '2px' }}>
            Edita el nombre y cuerpo de cada uno si quieres personalizar. Luego selecciona los que quieres enviar.
          </div>
        </div>
        <button
          onClick={handleGenerate}
          disabled={generating}
          style={{
            backgroundColor: 'transparent', color: colors.purple,
            border: `1px solid ${colors.purple}66`, borderRadius: '7px',
            padding: '7px 12px', fontSize: '12px', fontWeight: 600,
            cursor: generating ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0,
          }}>
          {generating
            ? <><Loader size={12} style={{ animation: 'spin 1s linear infinite' }} /> Regenerando...</>
            : <><RefreshCw size={12} /> Regenerar</>}
        </button>
      </div>

      {error && (
        <div style={{ backgroundColor: '#3a1a1a', borderRadius: '8px', padding: '10px 12px', color: colors.red, fontSize: '13px', display: 'flex', gap: '8px' }}>
          <AlertCircle size={14} style={{ flexShrink: 0 }} /> {error}
        </div>
      )}

      {/* Template cards editables */}
      {cards.map((card, i) => (
        <BulkTemplateCard
          key={i}
          index={i}
          card={card}
          selected={!!selected[i]}
          onToggle={() => toggleCard(i)}
          onUpdate={(field, val) => updateCard(i, field, val)}
          colors={colors}
          result={results[i]}
        />
      ))}

      {/* Botón submit */}
      <div style={{
        position: 'sticky', bottom: 0,
        backgroundColor: colors.bgPanel,
        borderTop: `1px solid ${colors.border}`,
        padding: '14px 0 4px',
        display: 'flex', flexDirection: 'column', gap: '8px',
      }}>
        {selectedCount === 0 && (
          <div style={{ color: colors.yellow, fontSize: '12px', textAlign: 'center' }}>
            ⚠️ Selecciona al menos un template para enviar
          </div>
        )}
        <button
          onClick={handleSubmitAll}
          disabled={submitting || selectedCount === 0}
          style={{
            backgroundColor: (selectedCount > 0 && !submitting) ? colors.green : colors.bgHover,
            color: (selectedCount > 0 && !submitting) ? 'white' : colors.textSecondary,
            border: 'none', borderRadius: '10px',
            padding: '13px', fontSize: '14px', fontWeight: 700,
            cursor: (selectedCount > 0 && !submitting) ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            transition: 'all 0.15s',
          }}>
          {submitting
            ? <><Loader size={15} style={{ animation: 'spin 1s linear infinite' }} /> Enviando a Meta...</>
            : <><Send size={15} /> Enviar {selectedCount > 0 ? `${selectedCount} template${selectedCount !== 1 ? 's' : ''}` : 'templates'} a Meta →</>}
        </button>
        {submitting && (
          <div style={{ color: colors.textSecondary, fontSize: '11px', textAlign: 'center' }}>
            Enviando a Meta... esto puede tardar unos segundos por template.
          </div>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   BulkTemplateCard — card editable individual dentro de BulkGenerateTab
───────────────────────────────────────────────────────────────────────── */
function BulkTemplateCard({ index, card, selected, onToggle, onUpdate, colors, result }) {
  const [expanded, setExpanded] = useState(true);

  const inputStyle = {
    width: '100%', backgroundColor: colors.bgApp, color: colors.textPrimary,
    border: `1px solid ${colors.borderStrong}`, borderRadius: '7px',
    padding: '8px 10px', fontSize: '13px', outline: 'none',
    boxSizing: 'border-box', fontFamily: 'inherit',
  };

  const isSelected = selected && !result;

  return (
    <div style={{
      backgroundColor: colors.bgSub,
      border: `2px solid ${isSelected ? colors.purple + '66' : result?.success ? colors.green + '66' : result ? colors.red + '66' : colors.border}`,
      borderRadius: '12px', overflow: 'hidden',
      opacity: (!selected && !result) ? 0.6 : 1,
      transition: 'all 0.2s',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px',
        backgroundColor: isSelected ? `${colors.purple}11` : 'transparent',
      }}>
        {/* Toggle selección */}
        <button
          onClick={onToggle}
          disabled={!!result}
          style={{ background: 'none', border: 'none', cursor: result ? 'default' : 'pointer', padding: 0, display: 'flex', flexShrink: 0 }}>
          {result?.success
            ? <CheckCircle size={20} color={colors.greenLight} />
            : result
              ? <XCircle size={20} color={colors.red} />
              : selected
                ? <ToggleRight size={22} color={colors.purple} />
                : <ToggleLeft size={22} color={colors.textMuted} />}
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: colors.textSecondary, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Template {index + 1} · {card.category || 'MARKETING'} · {card.language || 'es'}
          </div>
          <div style={{ color: colors.textPrimary, fontWeight: 600, fontSize: '13px', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {card.name || `template_${index + 1}`}
          </div>
        </div>

        {result?.success && <StatusBadge status="PENDING" colors={colors} />}
        {result && !result.success && (
          <span style={{ color: colors.red, fontSize: '11px' }}>Error</span>
        )}

        <button
          onClick={() => setExpanded(p => !p)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, padding: '4px', display: 'flex', flexShrink: 0 }}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Body expandible editable */}
      {expanded && !result && (
        <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ marginTop: '12px' }}>
            <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: '4px' }}>
              Nombre (solo letras, números, guiones bajos)
            </label>
            <input
              value={card.name || ''}
              onChange={e => onUpdate('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
              style={inputStyle}
            />
          </div>

          {card.header !== undefined && (
            <div>
              <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: '4px' }}>
                Encabezado (opcional)
              </label>
              <input
                value={card.header || ''}
                onChange={e => onUpdate('header', e.target.value)}
                style={inputStyle}
                maxLength={60}
              />
            </div>
          )}

          <div>
            <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: '4px' }}>
              Cuerpo del mensaje *
            </label>
            <textarea
              value={card.body || ''}
              onChange={e => onUpdate('body', e.target.value)}
              rows={4}
              style={{ ...inputStyle, resize: 'vertical' }}
              maxLength={1024}
            />
            <div style={{ color: colors.textMuted, fontSize: '11px', marginTop: '3px' }}>
              {(card.body || '').length}/1024
            </div>
          </div>

          {/* Preview */}
          {card.body && (
            <div style={{ backgroundColor: colors.bgApp, borderRadius: '8px', padding: '10px 12px', border: `1px solid ${colors.border}` }}>
              <div style={{ color: colors.textMuted, fontSize: '10px', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.4px' }}>Vista previa</div>
              {card.header && <div style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '13px', marginBottom: '4px' }}>{card.header}</div>}
              <div style={{ color: colors.textPrimary, fontSize: '13px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{card.body}</div>
              {card.footer && <div style={{ color: colors.textSecondary, fontSize: '11px', marginTop: '6px' }}>{card.footer}</div>}
            </div>
          )}
        </div>
      )}

      {/* Resultado de error */}
      {result && !result.success && expanded && (
        <div style={{ padding: '0 14px 14px', borderTop: `1px solid ${colors.border}` }}>
          <div style={{ marginTop: '10px', backgroundColor: '#3a1a1a', borderRadius: '7px', padding: '8px 10px', fontSize: '12px', color: colors.red }}>
            {result.error || 'Error al enviar'}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   CreateTemplateForm — formulario manual de 1 template
───────────────────────────────────────────────────────────────────────── */
function CreateTemplateForm({ onCreated, colors }) {
  const [name,       setName]       = useState('');
  const [lang,       setLang]       = useState('es');
  const [category,   setCategory]   = useState('MARKETING');
  const [header,     setHeader]     = useState('');
  const [body,       setBody]       = useState('');
  const [footer,     setFooter]     = useState('');
  const [creating,   setCreating]   = useState(false);
  const [error,      setError]      = useState('');
  const [success,    setSuccess]    = useState('');

  // ── IA ──
  const [goal,        setGoal]        = useState('');
  const [generating,  setGenerating]  = useState(false);
  const [aiVarDescs,  setAiVarDescs]  = useState({});
  const [aiUsed,      setAiUsed]      = useState(false);

  // ── Valores de muestra para Meta ──
  const [varSamples,  setVarSamples]  = useState({});

  const vars = body
    ? [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1]))]
    : [];

  const handleGenerate = async () => {
    if (!goal.trim()) return;
    setGenerating(true); setError(''); setAiVarDescs({}); setAiUsed(false);
    try {
      const res = await templatesAPI.generate(goal.trim(), category, lang);
      if (!res.success) { setError(res.error || 'Error generando template'); return; }
      const d = res.data;
      if (d.name)   setName(d.name);
      if (d.header !== undefined) setHeader(d.header || '');
      if (d.body)   setBody(d.body);
      if (d.footer !== undefined) setFooter(d.footer || '');
      if (d.variables && Object.keys(d.variables).length) {
        setAiVarDescs(d.variables);
        const samples = {};
        Object.entries(d.variables).forEach(([n, desc]) => {
          const d2 = desc.toLowerCase();
          if (d2.includes('nombre')) samples[n] = 'Juan';
          else if (d2.includes('día') || d2.includes('semana')) samples[n] = '14';
          else if (d2.includes('producto')) samples[n] = 'huevos';
          else samples[n] = 'ejemplo';
        });
        setVarSamples(samples);
      }
      setAiUsed(true);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleCreate = async () => {
    setError(''); setSuccess('');
    if (!name.trim()) { setError('El nombre es requerido'); return; }
    if (!body.trim()) { setError('El cuerpo del mensaje es requerido'); return; }
    setCreating(true);
    try {
      const res = await templatesAPI.create({ name, language: lang, category, header, body, footer, varSamples });
      if (res.success) {
        setSuccess(`✅ Template "${name}" creado — estado: ${res.status || 'PENDING'}. Meta lo revisará en las próximas horas.`);
        setName(''); setHeader(''); setBody(''); setFooter('');
        setGoal(''); setAiVarDescs({}); setAiUsed(false); setVarSamples({});
        onCreated?.();
      } else {
        setError(res.error || 'Error creando template');
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setCreating(false);
    }
  };

  const sel = {
    backgroundColor: colors.bgApp, color: colors.textPrimary,
    border: `1px solid ${colors.borderStrong}`, borderRadius: '8px',
    padding: '9px 12px', fontSize: '13px', cursor: 'pointer', outline: 'none', width: '100%',
  };

  const inputStyle = {
    width: '100%', backgroundColor: colors.bgApp, color: colors.textPrimary,
    border: `1px solid ${colors.borderStrong}`, borderRadius: '8px',
    padding: '9px 12px', fontSize: '13px', outline: 'none', boxSizing: 'border-box',
    fontFamily: 'inherit',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

      {/* ── Sección IA ──────────────────────────────────────────────────── */}
      <div style={{
        background: `linear-gradient(135deg, ${colors.bgSub} 0%, ${colors.bgAccent2} 100%)`,
        border: `1px solid #2a4060`,
        borderRadius: '12px',
        padding: '14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <Sparkles size={15} color="#7b68ee" />
          <span style={{ color: colors.purple, fontSize: '13px', fontWeight: 700 }}>Generar con IA</span>
          <span style={{ color: colors.textMuted, fontSize: '11px' }}>— describe el objetivo y la IA crea el template</span>
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <textarea
            value={goal}
            onChange={e => setGoal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && goal.trim()) { e.preventDefault(); handleGenerate(); } }}
            placeholder="ej: recordarle al cliente sus productos favoritos cuando lleva más de 2 semanas sin comprar"
            rows={2}
            style={{
              ...inputStyle,
              flex: 1,
              backgroundColor: colors.bgAccent2,
              border: '1px solid #2a4060',
              resize: 'none',
              fontSize: '13px',
            }}
          />
          <button
            onClick={handleGenerate}
            disabled={generating || !goal.trim()}
            title="Generar template con IA (Enter)"
            style={{
              backgroundColor: (goal.trim() && !generating) ? '#7b68ee' : colors.bgAccent2,
              color: (goal.trim() && !generating) ? 'white' : colors.textMuted,
              border: `1px solid ${(goal.trim() && !generating) ? '#7b68ee' : colors.border}`,
              borderRadius: '9px',
              padding: '9px 14px',
              fontSize: '13px', fontWeight: 700,
              cursor: (goal.trim() && !generating) ? 'pointer' : 'not-allowed',
              display: 'flex', alignItems: 'center', gap: '6px',
              whiteSpace: 'nowrap', flexShrink: 0,
              transition: 'all 0.15s',
            }}>
            {generating
              ? <><Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> Generando...</>
              : <><Wand2 size={13} /> Generar</>}
          </button>
        </div>

        {aiUsed && Object.keys(aiVarDescs).length > 0 && (
          <div style={{ marginTop: '10px', backgroundColor: colors.bgApp, borderRadius: '8px', padding: '8px 12px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            <span style={{ color: colors.textMuted, fontSize: '11px', width: '100%', marginBottom: '2px' }}>Variables detectadas:</span>
            {Object.entries(aiVarDescs).sort(([a], [b]) => +a - +b).map(([n, desc]) => (
              <span key={n} style={{
                backgroundColor: `${colors.green}22`, color: colors.green, border: `1px solid ${colors.green}44`,
                borderRadius: '6px', padding: '2px 8px', fontSize: '11px',
              }}>
                {'{{' + n + '}}'} = {desc}
              </span>
            ))}
          </div>
        )}

        {aiUsed && (
          <div style={{ marginTop: '8px', color: '#7b68ee', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '5px' }}>
            <Sparkles size={10} /> Template generado — revisa y edita los campos antes de enviarlo a Meta
          </div>
        )}
      </div>

      {/* ── Separador ───────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ flex: 1, height: '1px', backgroundColor: colors.border }} />
        <span style={{ color: colors.textMuted, fontSize: '11px' }}>o edita manualmente</span>
        <div style={{ flex: 1, height: '1px', backgroundColor: colors.border }} />
      </div>

      {/* ── Idioma + Categoría en fila ───────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '10px' }}>
        <div style={{ flex: 1 }}>
          <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '5px' }}>Idioma *</label>
          <select value={lang} onChange={e => setLang(e.target.value)} style={sel}>
            {LANGUAGES.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '5px' }}>Categoría *</label>
          <select value={category} onChange={e => setCategory(e.target.value)} style={sel}>
            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <div style={{ color: colors.textMuted, fontSize: '10px', marginTop: '3px' }}>
            {CATEGORIES.find(c => c.value === category)?.desc}
          </div>
        </div>
      </div>

      {/* Nombre */}
      <div>
        <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '5px' }}>
          Nombre del template *
        </label>
        <input
          value={name}
          onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
          placeholder="ej: reenganche_frescos_cl"
          style={{ ...inputStyle, borderColor: aiUsed && name ? '#7b68ee44' : colors.borderStrong }}
        />
        <div style={{ color: colors.textMuted, fontSize: '11px', marginTop: '4px' }}>
          Solo minúsculas, números y guiones bajos. Ej: <code style={{ color: colors.textSecondary }}>reenganche_frescos</code>
        </div>
      </div>

      {/* Header (opcional) */}
      <div>
        <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '5px' }}>
          Encabezado (opcional)
        </label>
        <input
          value={header}
          onChange={e => setHeader(e.target.value)}
          placeholder="ej: 🌿 Productos Frescos del Campo"
          style={{ ...inputStyle, borderColor: aiUsed && header ? '#7b68ee44' : colors.borderStrong }}
          maxLength={60}
        />
        <div style={{ color: colors.textMuted, fontSize: '11px', marginTop: '4px' }}>{header.length}/60 · Aparece en negrita sobre el mensaje</div>
      </div>

      {/* Body */}
      <div>
        <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '5px' }}>
          Cuerpo del mensaje *
        </label>
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder={'Hola {{1}}, llevas {{2}} días sin pedir tus {{3}} favoritos. ¿Te hacemos un pedido hoy? 🌿'}
          rows={4}
          style={{ ...inputStyle, resize: 'vertical', borderColor: aiUsed && body ? '#7b68ee44' : colors.borderStrong }}
          maxLength={1024}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: '4px' }}>
          <div style={{ color: colors.textMuted, fontSize: '11px' }}>
            Usa <code style={{ color: colors.green }}>{'{{1}}'}</code>, <code style={{ color: colors.green }}>{'{{2}}'}</code>... para variables que la IA rellenará por cliente.
            {vars.length > 0 && <span style={{ color: colors.green }}> · {vars.length} variable{vars.length !== 1 ? 's' : ''} detectada{vars.length !== 1 ? 's' : ''}: {vars.map(v => `{{${v}}}`).join(', ')}</span>}
          </div>
          <span style={{ color: colors.textMuted, fontSize: '11px', flexShrink: 0, marginLeft: '8px' }}>{body.length}/1024</span>
        </div>
      </div>

      {/* ── Valores de muestra — OBLIGATORIO si hay variables ────────────── */}
      {vars.length > 0 && (
        <div style={{ backgroundColor: colors.greenTint, border: `1px solid ${colors.green}44`, borderRadius: '10px', padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px' }}>
            <span style={{ fontSize: '13px' }}>📋</span>
            <span style={{ color: colors.greenLight, fontSize: '13px', fontWeight: 700 }}>Valores de muestra</span>
            <span style={{ color: colors.textSecondary, fontSize: '11px' }}>— Meta los necesita para revisar el template</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {vars.sort((a, b) => +a - +b).map(n => (
              <div key={n} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{
                  backgroundColor: `${colors.green}22`, color: colors.green, border: `1px solid ${colors.green}44`,
                  borderRadius: '5px', padding: '3px 8px', fontSize: '12px', fontWeight: 700,
                  flexShrink: 0, fontFamily: 'monospace', minWidth: '36px', textAlign: 'center',
                }}>
                  {`{{${n}}}`}
                </span>
                {aiVarDescs[n] && (
                  <span style={{ color: colors.textSecondary, fontSize: '11px', flexShrink: 0 }}>{aiVarDescs[n]}</span>
                )}
                <input
                  value={varSamples[n] || ''}
                  onChange={e => setVarSamples(prev => ({ ...prev, [n]: e.target.value }))}
                  placeholder={aiVarDescs[n] ? `ej: ${aiVarDescs[n] === 'nombre del cliente' ? 'Juan' : aiVarDescs[n]}` : `valor de muestra para {{${n}}}`}
                  style={{
                    flex: 1, backgroundColor: colors.bgApp, color: colors.textPrimary,
                    border: `1px solid ${varSamples[n]?.trim() ? colors.green + '66' : colors.red + '44'}`,
                    borderRadius: '7px', padding: '7px 10px', fontSize: '13px',
                    outline: 'none', fontFamily: 'inherit',
                  }}
                />
              </div>
            ))}
          </div>
          <div style={{ marginTop: '8px', color: colors.textSecondary, fontSize: '11px' }}>
            Sin estos valores Meta rechaza el template automáticamente. No serán enviados a clientes — son solo para revisión.
          </div>
        </div>
      )}

      {/* Footer (opcional) */}
      <div>
        <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '5px' }}>
          Pie de mensaje (opcional)
        </label>
        <input
          value={footer}
          onChange={e => setFooter(e.target.value)}
          placeholder="ej: Responde STOP para no recibir mensajes"
          style={inputStyle}
          maxLength={60}
        />
      </div>

      {/* Preview */}
      {body && (
        <div>
          <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '5px' }}>Vista previa</label>
          <div style={{ backgroundColor: colors.bgApp, borderRadius: '8px', padding: '12px 14px', border: `1px solid ${colors.border}`, maxWidth: '360px' }}>
            {header && <div style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '13px', marginBottom: '6px' }}>{header}</div>}
            <div style={{ color: colors.textPrimary, fontSize: '13px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {body.replace(/\{\{(\d+)\}\}/g, (_, n) => {
                const desc = aiVarDescs[n];
                return desc ? `[${desc}]` : `[var${n}]`;
              })}
            </div>
            {footer && <div style={{ color: colors.textSecondary, fontSize: '11px', marginTop: '6px' }}>{footer}</div>}
          </div>
        </div>
      )}

      {/* Info Meta */}
      <div style={{ backgroundColor: colors.bgSub, borderRadius: '8px', padding: '10px 12px', fontSize: '12px', color: colors.textSecondary, lineHeight: 1.6, display: 'flex', gap: '8px' }}>
        <Info size={14} color="#4db6e8" style={{ flexShrink: 0, marginTop: '1px' }} />
        <span>
          Los templates de categoría <strong style={{ color: colors.textPrimary }}>Marketing</strong> son revisados por Meta y normalmente aprobados en <strong style={{ color: colors.textPrimary }}>1-24 horas</strong>.
          Una vez aprobados aparecerán en Re-enganche con el badge <span style={{ color: colors.greenLight }}>✓ Aprobado</span>.
        </span>
      </div>

      {error   && <div style={{ backgroundColor: '#3a1a1a', color: colors.red,       borderRadius: '7px', padding: '10px 12px', fontSize: '13px' }}>{error}</div>}
      {success && <div style={{ backgroundColor: colors.greenTint, color: colors.greenLight, borderRadius: '7px', padding: '10px 12px', fontSize: '13px' }}>{success}</div>}

      {vars.length > 0 && vars.some(n => !varSamples[n]?.trim()) && (
        <div style={{ backgroundColor: '#2a1a00', border: '1px solid #ff8c0044', borderRadius: '7px', padding: '9px 12px', fontSize: '12px', color: colors.yellow, display: 'flex', gap: '7px', alignItems: 'flex-start' }}>
          <span style={{ flexShrink: 0 }}>⚠️</span>
          <span>Completa los <strong>valores de muestra</strong> de todas las variables. Meta los exige para aprobar el template.</span>
        </div>
      )}

      <button
        onClick={handleCreate}
        disabled={creating || !name.trim() || !body.trim() || (vars.length > 0 && vars.some(n => !varSamples[n]?.trim()))}
        style={{
          backgroundColor: (name.trim() && body.trim() && (vars.length === 0 || vars.every(n => varSamples[n]?.trim()))) ? colors.green : colors.border,
          color: (name.trim() && body.trim() && (vars.length === 0 || vars.every(n => varSamples[n]?.trim()))) ? 'white' : colors.textSecondary,
          border: 'none', borderRadius: '9px', padding: '12px',
          fontSize: '14px', fontWeight: 700,
          cursor: (name.trim() && body.trim() && (vars.length === 0 || vars.every(n => varSamples[n]?.trim()))) ? 'pointer' : 'not-allowed',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          opacity: creating ? 0.7 : 1,
        }}>
        {creating
          ? <><Loader size={15} style={{ animation: 'spin 1s linear infinite' }} /> Enviando a Meta...</>
          : <><Plus size={15} /> Crear Template</>}
      </button>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   TemplateManager — componente raíz
───────────────────────────────────────────────────────────────────────── */
export default function TemplateManager() {
  const { colors } = useTheme();
  const [tab, setTab]             = useState('list');   // 'list' | 'bulk' | 'create'
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [deleting, setDeleting]   = useState(null);

  const loadTemplates = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await templatesAPI.getAll();
      setTemplates(res.data || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'list') loadTemplates();
  }, [tab, loadTemplates]);

  const handleDelete = async (name) => {
    if (!window.confirm(`¿Eliminar el template "${name}"? Esta acción no se puede deshacer.`)) return;
    setDeleting(name);
    try {
      await templatesAPI.delete(name);
      setTemplates(prev => prev.filter(t => t.name !== name));
    } catch (err) {
      alert('Error eliminando: ' + (err.response?.data?.error || err.message));
    } finally {
      setDeleting(null);
    }
  };

  const approved = templates.filter(t => t.status === 'APPROVED');
  const pending  = templates.filter(t => t.status === 'PENDING');
  const rejected = templates.filter(t => t.status === 'REJECTED');

  const tabs = [
    { key: 'list',   label: '📋 Mis Templates', count: templates.length },
    { key: 'bulk',   label: '✨ Del Catálogo',   highlight: true },
    { key: 'create', label: '+ Crear Template' },
  ];

  return (
    <div style={{ color: colors.textPrimary }}>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0', marginBottom: '16px', backgroundColor: colors.bgApp, borderRadius: '9px', padding: '3px' }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              flex: 1, padding: '8px 10px', border: 'none',
              backgroundColor: tab === t.key
                ? (t.highlight ? `${colors.purple}22` : colors.bgPanel)
                : 'transparent',
              color: tab === t.key
                ? (t.highlight ? colors.purple : colors.textPrimary)
                : colors.textSecondary,
              borderRadius: '7px', cursor: 'pointer', fontSize: '13px',
              fontWeight: tab === t.key ? 700 : 400,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
              outline: tab === t.key && t.highlight ? `1px solid ${colors.purple}44` : 'none',
              transition: 'all 0.15s',
            }}>
            {t.label}
            {t.count != null && t.count > 0 && (
              <span style={{ backgroundColor: `${colors.green}33`, color: colors.green, borderRadius: '8px', padding: '1px 6px', fontSize: '11px', fontWeight: 700 }}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Lista de templates */}
      {tab === 'list' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div style={{ color: colors.textSecondary, fontSize: '12px' }}>
              {approved.length > 0 && <span style={{ color: colors.greenLight }}>{approved.length} aprobado{approved.length !== 1 ? 's' : ''}</span>}
              {pending.length > 0  && <><span style={{ color: colors.textMuted }}> · </span><span style={{ color: colors.yellow }}>{pending.length} pendiente{pending.length !== 1 ? 's' : ''}</span></>}
              {rejected.length > 0 && <><span style={{ color: colors.textMuted }}> · </span><span style={{ color: colors.red }}>{rejected.length} rechazado{rejected.length !== 1 ? 's' : ''}</span></>}
              {templates.length === 0 && !loading && 'Sin templates creados aún'}
            </div>
            <button onClick={loadTemplates} disabled={loading}
              style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, fontSize: '12px' }}>
              <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
              Recargar
            </button>
          </div>

          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: colors.textSecondary }}>
              <Loader size={24} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
          ) : error ? (
            <div style={{ color: colors.red, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', padding: '12px', backgroundColor: '#3a1a1a', borderRadius: '8px' }}>
              <AlertCircle size={14} /> {error}
            </div>
          ) : templates.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: colors.textSecondary }}>
              <FileText size={40} style={{ opacity: 0.2, marginBottom: '12px' }} />
              <div style={{ fontSize: '14px', fontWeight: 500 }}>Sin templates</div>
              <div style={{ fontSize: '12px', marginTop: '6px', opacity: 0.7 }}>Crea templates para poder enviarlos en Re-enganche</div>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '16px' }}>
                <button onClick={() => setTab('bulk')}
                  style={{ backgroundColor: colors.purple, color: 'white', border: 'none', borderRadius: '8px', padding: '8px 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
                  ✨ Generar del catálogo
                </button>
                <button onClick={() => setTab('create')}
                  style={{ backgroundColor: colors.green, color: 'white', border: 'none', borderRadius: '8px', padding: '8px 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
                  + Crear manualmente
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {templates.map(t => (
                <TemplateCard key={t.name} template={t} onDelete={handleDelete} deleting={deleting} colors={colors} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Generar del catálogo (bulk) */}
      {tab === 'bulk' && (
        <BulkGenerateTab onSubmitted={() => { setTimeout(() => setTab('list'), 1500); }} colors={colors} />
      )}

      {/* Crear template manual */}
      {tab === 'create' && (
        <CreateTemplateForm onCreated={() => { setTab('list'); loadTemplates(); }} colors={colors} />
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
