// Text that passes document.service's isUKLegalDocument relevance check
const UK_CONTRACT = `CONTRACT OF EMPLOYMENT
This employment contract is made between Acme Ltd, registered at Companies House, London, England and Jane Smith.
1. Salary: £32,000 per annum paid monthly.
2. Notice period: The employee must give 1 week notice. The employer will give 1 week notice regardless of length of service.
3. Annual leave: 15 days holiday entitlement including bank holidays.
4. Statutory sick pay applies. Disciplinary procedure and grievance procedure are set out in the staff handbook.
Governed by the laws of England and Wales under the Employment Rights Act 1996.`;

const RECIPE =
  "How to bake a chocolate cake: mix flour, sugar, eggs, cocoa and butter, then bake for 30 minutes at 180 degrees. Serve with cream.";

module.exports = { UK_CONTRACT, RECIPE };
