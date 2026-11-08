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

// A cut-down Section 86 with the parts that broke the old parser:
// metadata and commentaries (noise), an inline <Term> (text stored under "_"),
// a <CommentaryRef>, and nested P1/P2/P3 numbering.
const SECTION_86_XML = `<Legislation>
  <ukm:Metadata xmlns:ukm="x"><ukm:Supersedes>Workers (Predictable Terms and Conditions) Act 2023 (repealed)</ukm:Supersedes></ukm:Metadata>
  <Primary>
    <PrimaryPrelims><Title>Employment Rights Act 1996</Title><LongTitle>An Act to consolidate enactments relating to employment rights.</LongTitle></PrimaryPrelims>
    <Body>
      <Part><Title>Termination of employment</Title>
        <P1group><Title>Rights of employer and employee to minimum notice.</Title>
          <P1><Pnumber>86</Pnumber><P1para>
            <P2><Pnumber>1</Pnumber><P2para>
              <Text>The notice required to be given by an employer to terminate the contract of employment of a person who has been continuously employed for one month or more<CommentaryRef Ref="c1"/>—</Text>
              <P3><Pnumber>a</Pnumber><P3para><Text>is not less than one week’s notice if his period of continuous employment is less than two years,</Text></P3para></P3>
              <P3><Pnumber>b</Pnumber><P3para><Text>is not less than one week’s notice for each year of continuous employment if his period of continuous employment is two years or more but less than twelve years,</Text></P3para></P3>
            </P2para></P2>
            <P2><Pnumber>2</Pnumber><P2para><Text>The notice required to be given by an <Term>employee</Term> who has been continuously employed for one month or more is not less than one week.</Text></P2para></P2>
          </P1para></P1>
        </P1group>
      </Part>
    </Body>
  </Primary>
  <Commentaries><Commentary id="c1"><Para><Text>S. 86(5) omitted (1.10.2002) by virtue of <Citation>S.I. 2002/2034</Citation></Text></Para></Commentary></Commentaries>
</Legislation>`;

// SECTION_86_XML retitled as the Act a source URL is expected to hold
const { getLegislationInfo } = require("../services/legislationParser");
const fixtureFor = (url) =>
  SECTION_86_XML.replace(
    "<Title>Employment Rights Act 1996</Title>",
    `<Title>${getLegislationInfo(url).title}</Title>`
  );

module.exports = { UK_CONTRACT, RECIPE, SECTION_86_XML, fixtureFor };
