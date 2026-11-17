-- Customer agent reorder nudges: promotional restock reminder copy for the
-- AGENT_REORDER_NUDGE event (template key agent.reorder_nudge). Neutral copy
-- only; system-generated nudges never carry discount claims.
-- Up Migration
INSERT INTO notification_templates(template_key,locale,channel,subject,body) VALUES
 ('agent.reorder_nudge','en','PUSH','Time to restock','Time to restock {{productName}}? Tap to reorder.'),
 ('agent.reorder_nudge','en','INBOX','Time to restock','Time to restock {{productName}}? Open the assistant to reorder.'),
 ('agent.reorder_nudge','hi','PUSH','दोबारा खरीदने का समय','{{productName}} दोबारा खरीदने का समय हो गया? टैप करके ऑर्डर करें।'),
 ('agent.reorder_nudge','hi','INBOX','दोबारा खरीदने का समय','{{productName}} दोबारा खरीदने का समय हो गया? असिस्टेंट में ऑर्डर करें।'),
 ('agent.reorder_nudge','te','PUSH','మళ్లీ కొనే సమయం','{{productName}} మళ్లీ కొనే సమయం వచ్చిందా? నొక్కి ఆర్డర్ చేయండి.'),
 ('agent.reorder_nudge','te','INBOX','మళ్లీ కొనే సమయం','{{productName}} మళ్లీ కొనే సమయం వచ్చిందా? అసిస్టెంట్‌లో ఆర్డర్ చేయండి.');

-- Down Migration
DELETE FROM notification_templates WHERE template_key='agent.reorder_nudge';
