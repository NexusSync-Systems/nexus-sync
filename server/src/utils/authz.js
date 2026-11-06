const { normalizeRole } = require('./roleUtils');

const roleName = (role) => {
  if (!role) return '';
  return typeof role === 'string' ? role : role.name || '';
};

const normalizedRoleName = (role) => normalizeRole(roleName(role));

const isAppOwnerRole = (role) => {
  const normalized = normalizedRoleName(role);
  return Boolean(role?.isAppOwner) || normalized === 'app_owner' || normalized === 'owner';
};

// Účet modelky. Rozhoduje se podle NÁZVU role, ne podle příznaku, protože
// žádný příznak „tohle je modelka" ve schématu není — a stejně jako
// u `isManagerRole` tím projdou i agentury se staršími daty.
//
// Obě podoby názvu: role z `vychoziRole.js` se jmenuje „Model", ale
// `normalizeRole` zahazuje diakritiku a mezery, takže ručně založená
// „Modelka" se pozná taky.
const isModelRole = (role) => ['model', 'modelka'].includes(normalizedRoleName(role));

const isManagerRole = (role) => {
  const normalized = normalizedRoleName(role);
  return Boolean(role?.isManager) ||
    isAppOwnerRole(role) ||
    ['agency_admin', 'admin', 'manager', 'senior_manager', 'senior_operator'].includes(normalized);
};

const requireAppOwner = (req, res, next) => {
  if (!isAppOwnerRole(req.user?.role)) {
    return res.status(403).json({ message: 'Access denied: App Owner role required' });
  }
  next();
};

// Manager+ (Agency Admin / Senior Operator / App Owner). Operatoři a Modelky ne.
const requireManager = (req, res, next) => {
  if (!isManagerRole(req.user?.role)) {
    return res.status(403).json({ message: 'Insufficient permissions' });
  }
  next();
};

module.exports = {
  roleName,
  normalizedRoleName,
  isAppOwnerRole,
  isManagerRole,
  isModelRole,
  requireAppOwner,
  requireManager
};
