// Local development entry point. On Vercel, api/index.js is used instead.
import app from './app.js';

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Chatbot SaaS listening on http://localhost:${port}`));
