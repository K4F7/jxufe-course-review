-- Reviews enter public projections only while status='approved'.
-- public_review_counts, public_relation_ratings, and teacher review totals
-- also require the guest visibility predicate (not blocked, not deleted,
-- login_only=0, relation and offering still bind). PE canonical preference
-- uses the same approved text rows, but not login_only or offering binding.
-- A pending or rejected row therefore cannot change a published projection.
--
-- Approved rows still mark the whole projection dirty. One newly visible
-- text review can change publicPeHasTextReviewSql, canonical_course_id,
-- teacher course counts, and relation totals together. Patching only the
-- count and rating tables would publish a stale canonical map, and doing
-- that without bumping generation would race an in-flight staging publish.

DROP TRIGGER IF EXISTS public_precompute_dirty_reviews_insert;
DROP TRIGGER IF EXISTS public_precompute_dirty_reviews_update;
DROP TRIGGER IF EXISTS public_precompute_dirty_reviews_delete;

CREATE TRIGGER public_precompute_dirty_reviews_insert
AFTER INSERT ON reviews
WHEN NEW.status='approved'
BEGIN
  UPDATE public_precompute_state
  SET dirty=1,generation=generation+1,refresh_token=NULL,refresh_lease_until=NULL
  WHERE id=1 AND (dirty=0 OR refresh_token IS NOT NULL);
END;

CREATE TRIGGER public_precompute_dirty_reviews_update
AFTER UPDATE OF course_id,teacher_id,status,comment,overall,blocked_at,deleted_at,login_only,offering_id ON reviews
WHEN OLD.status='approved' OR NEW.status='approved'
BEGIN
  UPDATE public_precompute_state
  SET dirty=1,generation=generation+1,refresh_token=NULL,refresh_lease_until=NULL
  WHERE id=1 AND (dirty=0 OR refresh_token IS NOT NULL);
END;

CREATE TRIGGER public_precompute_dirty_reviews_delete
AFTER DELETE ON reviews
WHEN OLD.status='approved'
BEGIN
  UPDATE public_precompute_state
  SET dirty=1,generation=generation+1,refresh_token=NULL,refresh_lease_until=NULL
  WHERE id=1 AND (dirty=0 OR refresh_token IS NOT NULL);
END;
