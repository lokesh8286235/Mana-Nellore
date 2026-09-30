// Suggested starter category taxonomy seeded for every new restaurant.
// Restaurants can rename or delete any of these from the Menu screen.
const SUGGESTED_CATS = ['Biryani', 'Dosa', 'Starters', 'Chinese', 'South Indian',
  'North Indian', 'Tandoori & Kebabs', 'Burgers', 'Pizza', 'Sandwiches',
  'Rolls & Wraps', 'Fried Chicken', 'Meals & Combos', 'Desserts', 'Ice Cream', 'Beverages'];

async function seedSuggestedCats(db, restaurantId) {
  const { rows } = await db.query(
    'SELECT lower(name) AS n FROM categories WHERE restaurant_id = $1',
    [restaurantId]
  );
  const have = new Set(rows.map(r => r.n));
  let order = 0;
  for (const name of SUGGESTED_CATS) {
    if (have.has(name.toLowerCase())) continue; // idempotent: never duplicate
    await db.query(
      'INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1, $2, $3)',
      [restaurantId, name, order++]
    );
  }
}

module.exports = { SUGGESTED_CATS, seedSuggestedCats };
