const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');
const url = require('url');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const CREDENTIALS_PATH = 'credentials.json';
const TOKEN_PATH = 'token.json';

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id } = credentials.web;
  
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    'http://localhost:3000/callback'
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('\n🔗 Abrí este link en tu navegador:\n');
  console.log(authUrl);
  console.log('\n⏳ Esperando que autorices en el navegador...\n');

  // Servidor local que captura el código automáticamente
  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    if (parsedUrl.pathname === '/callback') {
      const code = parsedUrl.query.code;
      
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>✅ Autorización exitosa! Podés cerrar esta ventana y volver al cmd.</h2>');
        
        server.close();
        
        try {
          const { tokens } = await oAuth2Client.getToken(code);
          oAuth2Client.setCredentials(tokens);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
          
          console.log('✅ Token guardado en token.json');
          console.log('🎉 Google Calendar conectado exitosamente!\n');

          // Mostrar calendarios disponibles
          const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
          const { data } = await calendar.calendarList.list();
          
          console.log('📅 Tus calendarios disponibles:');
          data.items.forEach((cal, i) => {
            console.log(`  ${i + 1}. ${cal.summary}`);
            console.log(`     ID: ${cal.id}`);
          });
          console.log('\n👉 Copiá el ID del calendario principal y pegalo en el .env como GOOGLE_CALENDAR_ID\n');
          
        } catch (error) {
          console.error('Error obteniendo token:', error.message);
        }
      } else {
        res.writeHead(400);
        res.end('Error: no se recibió el código');
      }
    }
  });

  server.listen(3000, () => {
    console.log('🖥️  Servidor local iniciado en puerto 3000\n');
  });
}

authorize();