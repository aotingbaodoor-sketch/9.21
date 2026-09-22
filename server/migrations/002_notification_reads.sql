CREATE TABLE notification_reads (
 notification_id uuid NOT NULL REFERENCES notifications(id),
 user_id uuid NOT NULL REFERENCES users(id),
 read_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(notification_id,user_id)
);
CREATE INDEX notification_reads_user_idx ON notification_reads(user_id);
