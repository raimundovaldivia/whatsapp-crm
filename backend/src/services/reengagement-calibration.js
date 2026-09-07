/**
 * reengagement-calibration.js
 *
 * Backtesting con historial real de Shopify:
 * Para cada cliente con 3+ órdenes, simula lo que hubiera predicho
 * el algoritmo en cada punto histórico y lo compara con lo que
 * realmente pasó. Genera un factor de calibración por organización.
 *
 * Factor = 1.0  → el algoritmo es perfecto históricamente
 * Factor = 0.7  → el algoritmo sobreestima un 30% → bajar confianzas
 * Factor = 1.2  → el algoritmo subestima → subir confianzas (cap 1.0)
 */

/**
 * Corre backtesting completo sobre el historial de órdenes.
 * @param {Array} allOrders  - órdenes de Shopify (ya normalizadas con phone)
 * @param {Function} normalizePhone - función normalizadora de teléfono
 * @returns {Object} calibrationResult
 */
function runBacktesting(allOrders, normalizePhone) {
  // ── 1. Agrupar órdenes por cliente (phone) ─────────────────────────
  const byCustomer = new Map();

  for (const order of allOrders) {
    const phone =
      normalizePhone(order.customer?.phone) ||
      normalizePhone(order.shippingAddress?.phone) ||
      null;
    if (!phone) continue;

    const date = new Date(order.createdAt || order.created_at);
    if (isNaN(date.getTime())) continue;

    const name =
      order.customer?.displayName ||
      order.customer?.name ||
      phone;

    if (!byCustomer.has(phone)) byCustomer.set(phone, { phone, name, dates: [] });
    byCustomer.get(phone).dates.push(date.getTime());
  }

  // ── 2. Backtesting por cliente ──────────────────────────────────────
  const customerResults = [];   // { phone, name, predictions, accuracy }
  let totalPredictions  = 0;
  let totalCorrect      = 0;
  let totalErrorDays    = 0;
  const bucketStats     = { high: { total:0, correct:0 }, mid: { total:0, correct:0 }, low: { total:0, correct:0 } };

  for (const [phone, { name, dates }] of byCustomer.entries()) {
    // Necesitamos al menos 3 órdenes para tener un punto de predicción con historial
    if (dates.length < 3) continue;

    // Ordenar por fecha asc
    const sorted = [...dates].sort((a, b) => a - b);

    const simulations = [];

    for (let i = 2; i < sorted.length; i++) {
      // Usamos sorted[0..i-1] para predecir la siguiente compra después de sorted[i-1]
      const historical = sorted.slice(0, i);

      // Calcular intervalos entre compras (en días)
      const intervals = [];
      for (let j = 1; j < historical.length; j++) {
        intervals.push((historical[j] - historical[j - 1]) / 86400000);
      }

      const avgFreq = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const stdDev  = Math.sqrt(
        intervals.map(x => Math.pow(x - avgFreq, 2)).reduce((a, b) => a + b, 0) / intervals.length
      );

      const lastOrder   = historical[historical.length - 1];
      const predictedMs = lastOrder + avgFreq * 86400000;
      const actualMs    = sorted[i];

      const errorDays = Math.abs((actualMs - predictedMs) / 86400000);

      // Tolerancia: 30% de la frecuencia promedio o mínimo 3 días
      const tolerance = Math.max(3, avgFreq * 0.30);
      const correct   = errorDays <= tolerance;

      // Estimar confianza que el algoritmo hubiera asignado
      const rawConfidence = estimateRawConfidence(avgFreq, stdDev, historical.length, sorted[i-1]);

      // Bucket por confianza estimada
      const bucket = rawConfidence >= 75 ? 'high' : rawConfidence >= 50 ? 'mid' : 'low';
      bucketStats[bucket].total++;
      if (correct) bucketStats[bucket].correct++;

      simulations.push({
        predictionIndex:   i,
        avgFreq:           Math.round(avgFreq),
        stdDev:            Math.round(stdDev),
        predictedDate:     new Date(predictedMs).toISOString().slice(0, 10),
        actualDate:        new Date(actualMs).toISOString().slice(0, 10),
        errorDays:         Math.round(errorDays),
        tolerance:         Math.round(tolerance),
        correct,
        rawConfidence,
      });

      totalPredictions++;
      if (correct) totalCorrect++;
      totalErrorDays += errorDays;
    }

    const customerAccuracy = simulations.length > 0
      ? simulations.filter(s => s.correct).length / simulations.length
      : null;

    customerResults.push({
      phone,
      name,
      totalOrders:       sorted.length,
      simulationsRun:    simulations.length,
      accuracy:          customerAccuracy ? Math.round(customerAccuracy * 100) : null,
      avgError:          simulations.length > 0
        ? Math.round(simulations.reduce((a, s) => a + s.errorDays, 0) / simulations.length)
        : null,
      lastSimulations:   simulations.slice(-3), // últimas 3 para debug
    });
  }

  // ── 3. Factor de calibración global ────────────────────────────────
  const accuracyRate = totalPredictions > 0 ? totalCorrect / totalPredictions : 0.5;
  const meanError    = totalPredictions > 0 ? totalErrorDays / totalPredictions : 0;

  // Si el 75% de predicciones son correctas → factor 1.0 (algoritmo bien calibrado)
  // Si el 50% son correctas → factor 0.67
  // Cap mínimo en 0.40 para no hacer todo inútil
  // Cap máximo en 1.10 (leve bonus si el algoritmo es conservador)
  const TARGET_ACCURACY = 0.75;
  let calibrationFactor = accuracyRate / TARGET_ACCURACY;
  calibrationFactor = Math.max(0.40, Math.min(1.10, calibrationFactor));

  // Factor por bucket: para el bucket de alta confianza (75%+)
  const highAccuracy = bucketStats.high.total > 0
    ? bucketStats.high.correct / bucketStats.high.total
    : null;

  // ── 4. Corrección por bucket ────────────────────────────────────────
  // Si el bucket alto tiene accuracy baja → el algoritmo sobreestima confianzas
  // Generamos factores separados por tier
  const bucketFactors = {
    high: bucketStats.high.total >= 5
      ? Math.max(0.40, Math.min(1.10, (bucketStats.high.correct / bucketStats.high.total) / 0.80))
      : calibrationFactor,
    mid:  bucketStats.mid.total >= 5
      ? Math.max(0.40, Math.min(1.10, (bucketStats.mid.correct  / bucketStats.mid.total)  / 0.65))
      : calibrationFactor,
    low:  bucketStats.low.total >= 5
      ? Math.max(0.40, Math.min(1.10, (bucketStats.low.correct  / bucketStats.low.total)  / 0.50))
      : calibrationFactor,
  };

  // ── 5. Insight textual ─────────────────────────────────────────────
  let insight;
  if (totalPredictions < 10) {
    insight = 'Historial insuficiente para calibración precisa (se necesitan clientes con 3+ órdenes).';
  } else if (accuracyRate >= 0.80) {
    insight = `El algoritmo es muy preciso: acierta el ${Math.round(accuracyRate*100)}% de las predicciones con error promedio de ${Math.round(meanError)} días. Factor de calibración: ${calibrationFactor.toFixed(2)} (sin ajuste significativo).`;
  } else if (accuracyRate >= 0.60) {
    insight = `Precisión moderada: ${Math.round(accuracyRate*100)}% de aciertos, error promedio ${Math.round(meanError)} días. El factor ${calibrationFactor.toFixed(2)} reduce las confianzas para ser más conservadores.`;
  } else {
    insight = `Alta variabilidad: solo ${Math.round(accuracyRate*100)}% de aciertos. Factor ${calibrationFactor.toFixed(2)} ajusta significativamente las confianzas. Posible causa: clientes con patrones de compra muy irregulares.`;
  }

  return {
    calibrationFactor:   parseFloat(calibrationFactor.toFixed(3)),
    bucketFactors,
    accuracyRate:        parseFloat(accuracyRate.toFixed(3)),
    meanErrorDays:       parseFloat(meanError.toFixed(1)),
    totalPredictions,
    totalCorrect,
    customersAnalyzed:   customerResults.length,
    customersSkipped:    byCustomer.size - customerResults.length,
    bucketStats: {
      high: { ...bucketStats.high, accuracy: bucketStats.high.total > 0 ? Math.round(bucketStats.high.correct/bucketStats.high.total*100) : null },
      mid:  { ...bucketStats.mid,  accuracy: bucketStats.mid.total  > 0 ? Math.round(bucketStats.mid.correct /bucketStats.mid.total *100) : null },
      low:  { ...bucketStats.low,  accuracy: bucketStats.low.total  > 0 ? Math.round(bucketStats.low.correct /bucketStats.low.total *100) : null },
    },
    topCustomers: customerResults
      .sort((a, b) => (b.simulationsRun || 0) - (a.simulationsRun || 0))
      .slice(0, 10)
      .map(c => ({ phone: c.phone.slice(0,7)+'****', name: c.name, accuracy: c.accuracy, avgError: c.avgError, orders: c.totalOrders })),
    insight,
    calibratedAt: new Date().toISOString(),
  };
}

/**
 * Estima la confianza RAW que el algoritmo habría asignado dado el historial.
 * Replica la lógica de Haiku: stdDev baja → confianza alta.
 */
function estimateRawConfidence(avgFreq, stdDev, nOrders, lastOrderMs) {
  const daysInactive = (Date.now() - lastOrderMs) / 86400000;

  // Base: stdDev relativa a la frecuencia
  const cv = avgFreq > 0 ? stdDev / avgFreq : 1; // coeficiente de variación
  let conf = 90 - cv * 40; // cv=0 → 90, cv=1 → 50, cv>1.25 → bajo

  // Penalizar clientes con pocos pedidos
  if (nOrders < 4) conf -= 15;
  else if (nOrders < 6) conf -= 8;

  // Ajuste por cuánto tiempo lleva inactivo vs frecuencia esperada
  if (avgFreq > 0) {
    const ratio = daysInactive / avgFreq;
    if (ratio > 2) conf -= 20;
    else if (ratio > 1.5) conf -= 10;
  }

  return Math.round(Math.max(10, Math.min(95, conf)));
}

/**
 * Aplica el factor de calibración a una confianza raw.
 * @param {number} rawConfidence - 0 a 100
 * @param {Object} calibration   - resultado de runBacktesting (o de DB)
 */
function applyCalibration(rawConfidence, calibration) {
  if (!calibration) return rawConfidence;

  const { calibrationFactor, bucketFactors } = calibration;

  let factor = calibrationFactor;
  if (bucketFactors) {
    if (rawConfidence >= 75) factor = bucketFactors.high ?? calibrationFactor;
    else if (rawConfidence >= 50) factor = bucketFactors.mid ?? calibrationFactor;
    else factor = bucketFactors.low ?? calibrationFactor;
  }

  const calibrated = Math.round(rawConfidence * factor);
  return Math.max(0, Math.min(100, calibrated));
}

module.exports = { runBacktesting, applyCalibration, estimateRawConfidence };
