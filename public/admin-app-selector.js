(function(root){
  function isActive(app){
    return Boolean(app&&app.integration_status==="approved"&&app.approval_status!=="pending"&&app.status==="active");
  }
  function options(apps){
    return (Array.isArray(apps)?apps:[]).filter(isActive).map(app=>({
      app_id:app.app_id,
      app_name:app.app_name||app.app_id,
      label:`${app.app_name||app.app_id} (${app.app_id})`,
    }));
  }
  function selectedValue(apps,appId){
    return options(apps).some(app=>app.app_id===appId)?appId:"";
  }
  function synchronize(selects,apps,appId){
    const selected=selectedValue(apps,appId);
    for(const select of selects)select.value=selected;
    return selected;
  }
  root.SHFAAppSelector=Object.freeze({isActive,options,selectedValue,synchronize});
})(typeof window==="undefined"?globalThis:window);
