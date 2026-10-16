/**
 * Configuración Global — Pantallas de Embarque (GIDS)
 */
module.exports = {
  port: process.env.PORT || 3002,
  fidsUrl: process.env.FIDS_URL || 'http://127.0.0.1:8080',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '15000', 10), // cada 15 segundos
  airportName: process.env.AIRPORT_NAME || 'Aeropuerto Internacional',
  airportCode: process.env.AIRPORT_CODE || 'AER',
  defaultGates: (process.env.DEFAULT_GATES || '1,2,3,4,5,6,7,8,9,10').split(',').map(s => s.trim()),
  generalFids: {
    enabled: process.env.ENABLE_GENERAL_FIDS === 'true',
    nacionalUrl: process.env.FIDS_NACIONAL_URL || '',
    internacionalUrl: process.env.FIDS_INTERNACIONAL_URL || '',
    internacionalGates: (process.env.FIDS_INTERNACIONAL_GATES || '10,11,12,13').split(',').map(s => s.trim())
  },
  standbyMessage: {
    title: 'PUERTA DISPONIBLE',
    titleEn: 'GATE AVAILABLE',
    subtitle: 'Próximo vuelo por asignar',
    subtitleEn: 'Next flight pending assignment'
  }
};
