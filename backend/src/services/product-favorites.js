function favoriteInput(productId, visitorId, favorite) {
  const id = Number(productId);
  if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('Producto inválido'), { status: 400 });
  if (typeof visitorId !== 'string' || !/^[a-z0-9-]{16,100}$/i.test(visitorId)) {
    throw Object.assign(new Error('Identificador de visitante inválido'), { status: 400 });
  }
  if (typeof favorite !== 'boolean') throw Object.assign(new Error('Estado de favorito inválido'), { status: 400 });
  return { productId: id, visitorId, favorite };
}

async function setProductFavorite(pool, { organizationId, productId, visitorId, favorite }) {
  const input = favoriteInput(productId, visitorId, favorite);
  const { rows } = await pool.query(
    `SELECT id FROM products
      WHERE id = $1 AND organization_id = $2 AND active = TRUE
        AND COALESCE(is_business, FALSE) = FALSE`,
    [input.productId, organizationId]
  );
  if (!rows[0]) return null;

  if (input.favorite) {
    await pool.query(
      `INSERT INTO store_product_favorites (organization_id, product_id, visitor_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [organizationId, input.productId, input.visitorId]
    );
  } else {
    await pool.query(
      `DELETE FROM store_product_favorites
        WHERE organization_id = $1 AND product_id = $2 AND visitor_id = $3`,
      [organizationId, input.productId, input.visitorId]
    );
  }

  const count = await pool.query(
    `SELECT COUNT(*)::int AS count FROM store_product_favorites
      WHERE organization_id = $1 AND product_id = $2`,
    [organizationId, input.productId]
  );
  return { favorite: input.favorite, count: count.rows[0].count };
}

async function getFavoriteCounts(pool, organizationId) {
  const { rows } = await pool.query(
    `SELECT product_id, COUNT(*)::int AS count
       FROM store_product_favorites
      WHERE organization_id = $1
      GROUP BY product_id`,
    [organizationId]
  );
  return new Map(rows.map(row => [Number(row.product_id), Number(row.count)]));
}

module.exports = { favoriteInput, setProductFavorite, getFavoriteCounts };
