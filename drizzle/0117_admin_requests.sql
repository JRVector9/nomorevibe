ALTER TABLE maker_replies ADD COLUMN review_version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE maker_replies ADD COLUMN review_required boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE maker_replies SET review_required = true WHERE review_state = 'rejected';
--> statement-breakpoint
ALTER TABLE maker_replies ADD CONSTRAINT maker_replies_review_version_check CHECK (review_version > 0);
--> statement-breakpoint
CREATE INDEX maker_replies_review_queue_idx ON maker_replies (review_state, created_at, id);
--> statement-breakpoint
CREATE TABLE admin_contact_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_email varchar(254) NOT NULL,
  subject varchar(200) NOT NULL,
  body varchar(10000) NOT NULL,
  received_at timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'new',
  handling_note varchar(2000) NOT NULL DEFAULT '',
  created_by varchar(120) NOT NULL,
  updated_by varchar(120) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_contact_requests_status_check CHECK (status IN ('new', 'in_progress', 'waiting', 'resolved', 'spam')),
  CONSTRAINT admin_contact_requests_version_check CHECK (version > 0),
  CONSTRAINT admin_contact_requests_content_check CHECK (char_length(btrim(sender_email)) > 0 AND char_length(btrim(subject)) > 0 AND char_length(btrim(body)) > 0)
);
--> statement-breakpoint
CREATE INDEX admin_contact_requests_queue_idx ON admin_contact_requests (status, received_at, id);
