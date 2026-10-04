-- The latest feed orders approved reviews by created_at and the public id
-- ('review:' || id). idx_reviews_status_created has no id term, so a branch
-- LIMIT still sorts every approved row. This index matches that order.
CREATE INDEX IF NOT EXISTS idx_reviews_public_latest
  ON reviews(status, created_at DESC, ('review:' || id) DESC);
