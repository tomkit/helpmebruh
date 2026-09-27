const copy = document.querySelector("[data-copy]");

copy?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(copy.dataset.copy);
  const label = copy.querySelector("span");
  label.textContent = "Copied";
  window.setTimeout(() => { label.textContent = "Copy"; }, 1600);
});
