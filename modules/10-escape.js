// R0b-1: shared escaper, moved unchanged from the inline script. Classic script: shares the page's global scope.
/* Shared escaper for text AND attribute values (both quote kinds, < and >). */
function escA(x){return String(x??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
/* A value passed to an inline handler: a JSON string literal, then attribute-escaped. Never splice '${x}' into a handler. */
function jsA(x){return escA(JSON.stringify(String(x??'')))}
