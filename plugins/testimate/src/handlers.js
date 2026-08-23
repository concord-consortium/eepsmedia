/* global testimate, connect, data, ui */


const handlers = {

    getPluginState : function() {
        return {
            success: true,
            values: {
                store: testimate.state,
            }
        };
    },

    restorePluginFromStore: function(iStorage) {
        if (iStorage) {
            testimate.state = iStorage.store;
        }
    },

    /**
     * User has clicked a button that changes whether a test is one- or two-sided
     */
    changeTestSides: function () {
        const theParams = testimate.state.testParams;
        theParams.sides = theParams.sides === 1 ? 2 : 1;
        testimate.determineSidesOp();
        testimate.refreshDataAndTestResults();
    },

    /**
     * User changes the confidence level in test configuration
     */
    changeConf: function () {
        const a = document.getElementById(`confBox`);
        testimate.state.testParams.conf = a.value;
        testimate.state.testParams.alpha = 1 - testimate.state.testParams.conf / 100;
        testimate.refreshDataAndTestResults();
    },

    /**
     * User changes alpha level in test configuration
     */
    changeAlpha: function () {
        const a = document.getElementById(`alphaBox`);
        testimate.state.testParams.alpha = a.value;
        testimate.state.testParams.conf = 100 * (1 - testimate.state.testParams.alpha);
        testimate.refreshDataAndTestResults();
    },

    /**
     * User changes the value against which data are tested in configuration.
     * As in, testing whether height is greater than 150 -- they changed the 150.
     */
    changeValue: function () {
        const v = document.getElementById(`valueBox`);
        testimate.state.testParams.value = Number(v.value);
        testimate.refreshDataAndTestResults();
    },

    changeIterations: function () {
        const v = document.getElementById(`iterBox`);
        testimate.state.testParams.iter = v.value;
        testimate.refreshDataAndTestResults();
    },

    changeRate: function () {
        const v = document.getElementById(`rateBox`);
        testimate.state.testParams.rate = v.value;
        testimate.refreshDataAndTestResults();
    },

    /**
     * Data emission: user changed the radio button that specifies the "emit mode":
     * single, a set of random, or all groups
     */
    changeEmitMode: function() {
        ui.emitMode = document.querySelector("input[name='emitMode']:checked").value;

        //  set emitMode to single if you're trying something impossible
        if (this.emitMode === 'random' && !data.hasRandom) {
            this.emitMode = 'single';
            alert("Can't emit using rerandomizing if there are no random attributes");  //  todo: localize
        }
        if (this.emitMode === 'hierarchical' && !data.isGrouped) {
            this.emitMode = 'single';
            alert("Can't emit for each subgroups if there are no subgroups");  //  todo: localize
        }

        testimate.refreshDataAndTestResults();
    },

    /**
     * User changes how many randomizations in random emit mode.
     */
    changeRandomEmitNumber: function () {
        const v = document.getElementById(`randomEmitNumberBox`);
        testimate.state.randomEmitNumber = v.value;
        testimate.refreshDataAndTestResults();
    },

    changeLogisticRegressionProbe: function () {
        const LRP = document.getElementById(`logisticRegressionProbeBox`);
        testimate.state.testParams.probe = LRP.value; //  need for state and restore
        testimate.refreshDataAndTestResults();
    },

    /**
     * User changes which test is selected by picking on in the menu
     */
    changeTest: function () {
        const T = document.getElementById(`testMenu`);
        testimate.makeFreshTest(T.value); //  the testID, need for state and restore
        testimate.refreshDataAndTestResults();
    },

    /**
     * User changes which group (categorical value) is the one
     * we're primarily counting the X (outcome) variable.
     * This is set in the test configuration.
     *
     * For example, in a test of proportion in a clinical trial,
     * we might count cases that are "getting well" as opposed to "remaining sick."
     */
    changeFocusGroupX: function () {
        const initialGroup = testimate.state.testParams.focusGroupX;
        const valueSet = [...data.xAttData.valueSet];
        const nextValue = this.nextValueInList(valueSet, initialGroup);
        testimate.state.testParams.focusGroupX = testimate.setFocusGroup(data.xAttData, nextValue);
        testimate.determineSidesOp();   //      the data are there already; this changes the sign, which changes pValue
        testimate.refreshDataAndTestResults();
    },

    /**
     * User changes which group (categorical value) is the one
     * we're primarily counting the Y (predictor) variable.
     *
     * For example, in a test of proportion in a clinical trial,
     * we might focus on cases that are in the "experimental" as opposed to "placebo" group.
     */

    changeFocusGroupY: function () {
        const initialGroup = testimate.state.testParams.focusGroupY;
        const valueSet = [...data.yAttData.valueSet];
        const nextValue = this.nextValueInList(valueSet, initialGroup);
        testimate.state.testParams.focusGroupY = testimate.setFocusGroup(data.yAttData, nextValue);
        testimate.determineSidesOp();
        testimate.refreshDataAndTestResults();
    },

    /**
     * User reverses the sense of a calculation in a "difference" test.
     * For example, calculate "Female - Male" for some quantity
     * instead fo "Male – Female."
     */
    reverseTestSubtraction : function() {
        testimate.state.testParams.reversed = !testimate.state.testParams.reversed;
        testimate.refreshDataAndTestResults();
    },

    /**
     * Change the TYPE (categorical or numeric = CN) of the attribute
     * @param iXY
     */
    changeCN: function (iXY) {
        const aName = (iXY === 'x') ? data.xName() : data.yName();
        const newType = (testimate.state.dataTypes[aName] === 'numeric' ? 'categorical' : 'numeric');
        testimate.state.dataTypes[aName] = newType;
        testimate.refreshDataAndTestResults();
    },


    /**
     * Change the proportions of the groups for a goodness of fit test.  
     * The last one is always 1 minus the sum of the others.
     * 
     * @param {*} iLast 
     */
    changeGoodnessProp: function(iLast) {
        console.log(`changing goodness prop for ${iLast}`);
        const theTest = testimate.theTest;

        let propSum = 0;
        const lastGroup = theTest.results.groupNames[theTest.results.groupNames.length - 1];

        theTest.results.groupNames.forEach(g => {
            let theBoxValue = 0;
            if (g !== lastGroup) {
                theBoxValue = Number(document.getElementById(`GProp_${g}`).value);
                const oldPropSum = propSum;
                propSum += theBoxValue;
                if (propSum > 1) {
                    theBoxValue = 1 - oldPropSum;
                    propSum = 1;
                }
            } else {    //  the last one!
                theBoxValue = 1 - propSum;
                const theLastBox = document.getElementById("lastProp");
                theLastBox.innerHTML = ui.numberToString(theBoxValue);
            }
            testimate.state.testParams.groupProportions[g] = (theBoxValue);
        });
        testimate.refreshDataAndTestResults();
    },

    /**
     * for logistic regression
     * @param iHowMany  how many more iterations
     */
    doMoreIterations : function(iHowMany) {
        testimate.theTest.moreIterations = iHowMany;
        testimate.theTest.newRegression = false;        //      we will add on
        testimate.refreshDataAndTestResults();
    },

    showRegressionGraph: function(iFormula) {
        //  const formulas = testimate.theTest.makeFormulaStrings();
        const xName = testimate.theTest.theConfig.name === "logistic regression" ?
            testimate.constants.logisticGroupAttributeName : data.xName();
        connect.showRegressionGraph(data.yName(), xName, iFormula);
    },

    /**
     * Utility! Find the next value in a list; wrap if at the end.
     * @param iList     the list
     * @param iValue    the current value
     * @returns {*}     the "next" value
     */
    nextValueInList: function (iList, iValue) {
        if (iValue) {
            const iOrig = iList.indexOf(iValue);
            const iNext = (iOrig + 1 >= iList.length) ? 0 : iOrig + 1;
            return iList[iNext];
        } else {
            return iList[0];
        }
    },


    /**
     * remove the attribute indicated
     * @param iXY
     */
    trashAttribute: function (iXY) {
        console.log(`removing attribute [${iXY}]`);
        testimate.state[iXY] = null;
        testimate.theTest = null;
        data.xAttData = null;
        data.yAttData = null;
        data.dirtyData = true;
        testimate.refreshDataAndTestResults();
    },
    /**
     * Set of routines to display logs efficiently to the console...
     */
    actionLog : [],

    startActionLog : function(firstItem) {
        handlers.actionLog = [firstItem];
    },

    addActionLog : function( item ) {
        handlers.actionLog.push(item);
    },

    displayActionLog : function() {
        let message = ">> " + handlers.actionLog.join(" ... ");
        console.log(message);
    },

    /**
     * emit test results to CODAP
     */
    emitSingle: async function () {
        this.startActionLog("single emit");

        const theTest = testimate.theTest;
        await connect.emitTestData({});

        this.displayActionLog();
        testimate.state.sequenceNumber++;
    },

    /**
     * re-randomize and then emit results to CODAP.
     */
    emitRandom: async function() {
        this.startActionLog("random emit");

        testimate.iteratingRandom = true;   //  set the flag

        for (let i = 0; i < testimate.state.randomEmitNumber; i++) {
            await connect.rerandomizeSource(testimate.state.dataset.name);
            await testimate.refreshDataAndTestResults();     //  recompute before emitting
            await connect.emitTestData({});

            // await this.emitSingle();
        }

        testimate.iteratingRandom = false;  //  clear the flag
        testimate.state.sequenceNumber++;

        testimate.refreshDataAndTestResults();

        this.addActionLog(`${testimate.state.randomEmitNumber}x`);
        this.displayActionLog();
    },

    emitHierarchy: async function() {
        this.startActionLog("group emit");

        for (let i = 0; i < data.topCases.length; i++ ) {
            const tc = data.topCases[i];

            const theTopValues = tc.values;    //  must match all of these

            const oneGroupDataset = data.filterGroupCases(data.allCODAPitems, theTopValues);
            if (oneGroupDataset) {
                await data.makeXandYArrays(oneGroupDataset);

                await data.removeInappropriateCases();
                await testimate.theTest.updateTestResults();  //  now we've done the test on this subset
                await connect.emitTestData(theTopValues);
            }
        }

        testimate.state.sequenceNumber++;
        await testimate.refreshDataAndTestResults();
        this.addActionLog(`${data.topCases.length} groups`);
        this.displayActionLog();
    },

};