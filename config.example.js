// Example runtime config for HERE Maps (do not commit real keys)
window.__HERE_CONFIG__ = {
	apiKey: "YOUR_HERE_API_KEY"
};

// Turnos config (override defaults). Copy to config.js and adjust times if needed.
window.__TURNOS_CFG__ = {
	// Timezone used for jornada and boundaries
	tz: 'America/Mexico_City',
	// AM window (inclusive)
	amStart: '09:00',
	amEnd: '14:59',
	// PM window (inclusive)
	pmStart: '15:00',
	pmEnd: '20:59',
	// Consider a single long session as COMPLETO if >= this many minutes
	fullMinMinutes: 420,
	// Auto split at PM start into a new turno when user stays logged in
	// Set to false to keep a single turno corrido and classify as COMPLETO when closing
	autoSplit: true,
	// Optional: require an open turno to register caja movements
	// strict: true
};
