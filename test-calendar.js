require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');

async function testCalendar() {
  try {
    const creds = JSON.parse(fs.readFileSync('credentials.json'));
    const auth = new google.auth.OAuth2(
      creds.web.client_id,
      creds.web.client_secret,
      'http://localhost:3000/callback'
    );
    auth.setCredentials(JSON.parse(fs.readFileSync('token.json')));
    const cal = google.calendar({ version: 'v3', auth });

    const ahora = new Date();
    const en14dias = new Date();
    en14dias.setDate(en14dias.getDate() + 14);

    const { data } = await cal.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: ahora.toISOString(),
      timeMax: en14dias.toISOString(),
      maxResults: 20,
      singleEvents: true,
      orderBy: 'startTime'
    });

    if (!data.items || data.items.length === 0) {
      console.log('❌ No se encontraron eventos en los próximos 14 días');
      console.log('Calendar ID usado:', process.env.GOOGLE_CALENDAR_ID);
    } else {
      console.log(`✅ Se encontraron ${data.items.length} eventos:\n`);
      data.items.forEach(e => {
        const fecha = e.start.dateTime || e.start.date;
        console.log(`- ${e.summary || '(sin título)'} → ${fecha}`);
      });
    }
  } catch (e) {
    console.error('❌ Error:', e.message);
  }
}

testCalendar();