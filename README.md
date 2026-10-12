# Kiito MVP

Kiito is an MVP implementation based on **Kiito – tuotespeksi V1**.

It demonstrates the core V1 workflow:

- Incoming resident messages become tickets.
- AI triages company, apartment/resident, type and priority.
- Emergency issues bypass the normal decision queue.
- Tickets can be linked to existing tickets.
- Every normal outgoing action goes through a decision queue:
  - **AI hoitaa**
  - **Minä hoidan**
  - **Ohita**
- Company-specific knowledge is isolated by company.
- AI self-service answers use only the selected company's knowledge documents.
- Audit history is stored for decisions and ticket events.
- The project includes an API endpoint for incoming email/web messages.

## Stack

- Node.js + TypeScript
- Express API
- React + Vite
- SQLite
- Simple CSS
- Optional OpenAI integration through `OPENAI_API_KEY`
- Mock/rule-based AI fallback when no API key is configured

## Requirements

- Node.js 20+
- npm

## Run

Open the `kiito-mvp` folder in VS Code.

Terminal 1:

```bash
cd server
npm install
npm run dev
```

Terminal 2:

```bash
cd client
npm install
npm run dev
```

Then open the URL printed by Vite, normally:

http://localhost:5173

The API runs on:

http://localhost:4000

## Optional AI

Copy `server/.env.example` to `server/.env`.

Set:

```env
OPENAI_API_KEY=your_key
OPENAI_MODEL=your_model
```

If the key is absent, Kiito uses the deterministic local triage engine. This is useful for development and keeps the project runnable without an AI account.

`DEFAULT_COMPANY_ID` selects the default company. `AUTHORIZED_COMPANY_IDS` is a comma-separated server-side allowlist for the company selector and company-scoped ticket APIs (for example `demo-company,another-company`). Company IDs supplied by the browser are accepted only when present in this allowlist.

## Demo data

The server creates demo companies, apartments, residents, knowledge documents and tickets automatically on first startup.

## Incoming message API

POST:

`http://localhost:4000/api/inbound/messages`

Example:

```json
{
  "companyId": "demo-company",
  "channel": "email",
  "senderName": "Matti Meikäläinen",
  "senderEmail": "matti@example.com",
  "subject": "Keittiössä vuotaa vettä",
  "body": "Hanasta tulee vettä lattialle."
}
```

The backend creates a ticket, runs triage and either places it in the decision queue or routes it as an emergency.

## Important production work still needed

This is an MVP codebase, not a production-ready property-management platform. Before a real pilot you should add:

- Real authentication and RBAC
- Proper tenant/company authorization
- Production email ingestion
- Email sending
- Real resident registry synchronization
- File/image storage
- Malware scanning for attachments
- Real AI provider configuration and evaluation
- GDPR/DPA/DPIA implementation
- Encryption and secrets management
- Rate limiting and abuse protection
- Production database
- Monitoring, backups and audit retention
- Human approval enforcement on legally sensitive actions
- Emergency phone routing
- Integration with property-management systems

The product specification explicitly calls for human approval for outgoing actions except defined self-service/acknowledgement cases, and for company-level data isolation. Those principles are represented in the MVP architecture.
