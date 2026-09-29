-- A source person need not be an employee (delivery T01, A005).
ALTER TABLE crm_partners ALTER COLUMN user_id DROP NOT NULL;
-- Do not seed or map real user accounts by guessing identity.
