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
  Info, Sparkles, Wand2,
} from 'lucide-react';
import { templatesAPI } from '../utils/api.js';
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

const STATUS_CONFIG = {
  APPROVED: { color: '#00c853', bg: '#0a2e15', icon: CheckCircle, label: 'Aprobado' },
  PENDING:  { color: '#f0b429', bg: '#2e2100', icon: Clock,        label: 'Pendiente' },
  REJECTED: { color: '#e57373', bg: '#3a1a1a', icon: XCircle,      label: 'Rechazado' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.PENDING;
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

  // Detectar variables {{N}} en el body
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
      {/* Header de la card */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px' }}>
        <FileText size={15} color={colors.textSecondary} style={{ flexShrink: 0 }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '14px', fontFamily: 'monospace' }}>
              {template.name}
            </span>
            <StatusBadge status={template.status} />
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

      {/* Contenido expandible: preview del template */}
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
  const [aiVarDescs,  setAiVarDescs]  = useState({});  // { "1": "nombre del cliente", ... }
  const [aiUsed,      setAiUsed]      = useState(false);

  // ── Valores de muestra para Meta ──
  const [varSamples,  setVarSamples]  = useState({});  // { "1": "Juan", "2": "14" }

  // Detectar variables en el body en tiempo real
  const vars = body
    ? [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1]))]
    : [];

  // ── Generar con IA ──────────────────────────────────────────────────────
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
        // Pre-llenar muestras con valores típicos según descripción
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

  // ── Crear en Meta ───────────────────────────────────────────────────────
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

        {/* Descripciones de variables de la IA */}
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
        <div style={{ backgroundColor: '#1a2010', border: '1px solid #3a5020', borderRadius: '10px', padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px' }}>
            <span style={{ fontSize: '13px' }}>📋</span>
            <span style={{ color: '#a8d080', fontSize: '13px', fontWeight: 700 }}>Valores de muestra</span>
            <span style={{ color: '#5a7040', fontSize: '11px' }}>— Meta los necesita para revisar el template</span>
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
                  <span style={{ color: '#5a7040', fontSize: '11px', flexShrink: 0 }}>{aiVarDescs[n]}</span>
                )}
                <input
                  value={varSamples[n] || ''}
                  onChange={e => setVarSamples(prev => ({ ...prev, [n]: e.target.value }))}
                  placeholder={aiVarDescs[n] ? `ej: ${aiVarDescs[n] === 'nombre del cliente' ? 'Juan' : aiVarDescs[n]}` : `valor de muestra para {{${n}}}`}
                  style={{
                    flex: 1, backgroundColor: '#0f1a08', color: colors.textPrimary,
                    border: `1px solid ${varSamples[n]?.trim() ? '#3a5020' : '#ff665544'}`,
                    borderRadius: '7px', padding: '7px 10px', fontSize: '13px',
                    outline: 'none', fontFamily: 'inherit',
                  }}
                />
              </div>
            ))}
          </div>
          <div style={{ marginTop: '8px', color: '#5a7040', fontSize: '11px' }}>
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
      {success && <div style={{ backgroundColor: '#0a2e15', color: colors.greenLight, borderRadius: '7px', padding: '10px 12px', fontSize: '13px' }}>{success}</div>}

      {/* Advertencia si faltan muestras */}
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

export default function TemplateManager() {
  const { colors } = useTheme();
  const [tab, setTab]         = useState('list');   // 'list' | 'create'
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [deleting, setDeleting] = useState(null);   // nombre del template en borrado

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

  return (
    <div style={{ color: colors.textPrimary }}>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0', marginBottom: '16px', backgroundColor: colors.bgApp, borderRadius: '9px', padding: '3px' }}>
        {[
          { key: 'list',   label: 'Mis Templates', count: templates.length },
          { key: 'create', label: '+ Crear Template' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              flex: 1, padding: '8px 14px', border: 'none',
              backgroundColor: tab === t.key ? colors.bgPanel : 'transparent',
              color: tab === t.key ? colors.textPrimary : colors.textSecondary,
              borderRadius: '7px', cursor: 'pointer', fontSize: '13px', fontWeight: tab === t.key ? 600 : 400,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
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
              {pending.length > 0 && <><span style={{ color: colors.textMuted }}> · </span><span style={{ color: colors.yellow }}>{pending.length} pendiente{pending.length !== 1 ? 's' : ''}</span></>}
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
              <div style={{ fontSize: '12px', marginTop: '6px', opacity: 0.7 }}>Crea tu primer template para poder enviarlo en Re-enganche</div>
              <button onClick={() => setTab('create')}
                style={{ marginTop: '16px', backgroundColor: colors.green, color: 'white', border: 'none', borderRadius: '8px', padding: '8px 18px', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
                + Crear Template
              </button>
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

      {/* Crear template */}
      {tab === 'create' && (
        <CreateTemplateForm onCreated={() => { setTab('list'); loadTemplates(); }} colors={colors} />
      )}
    </div>
  );
}
